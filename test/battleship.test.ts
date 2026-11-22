import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET, N, battleship as g, randomFleet } from '../src/games/battleship.ts';
import type { Action, Placement, State } from '../src/games/battleship.ts';
import { mulberry32 } from '../src/kit/rng.ts';
import { GameError } from '../src/kit/types.ts';

const rng = mulberry32(1);
const place = (ships: Placement[]): Action => ({ t: 'place', ships });
const fleetRows = (): Placement[] => FLEET.map((_, i) => ({ r: i * 2, c: 0, dir: 'h' as const }));

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e) => e instanceof GameError && e.code === code, `ожидался код ${code}`);
}

function started(seed = 1, a = fleetRows(), b = randomFleet(mulberry32(seed))): State {
  let s = g.init(2, rng);
  s = g.apply(s, place(a), 0, mulberry32(seed));
  s = g.apply(s, place(b), 1, mulberry32(seed));
  return s;
}

test('разбор действий: мусор отвергается с понятным кодом', () => {
  for (const raw of [null, 5, 'fire', {}, { t: 'x' }, { t: 'fire' }, { t: 'fire', cell: -1 }, { t: 'fire', cell: 100 }, { t: 'fire', cell: 1.5 }, { t: 'fire', cell: '5' }, { t: 'place' }, { t: 'place', ships: [] }, { t: 'place', ships: [1, 2, 3, 4, 5] }, { t: 'place', ships: [{ r: 0, c: 0, dir: 'x' }, {}, {}, {}, {}] }]) {
    throwsCode(() => g.parseAction(raw), 'bad_action');
  }
  assert.deepEqual(g.parseAction({ t: 'fire', cell: 7, extra: 'игнорируется' }), { t: 'fire', cell: 7 });
});

test('расстановка: границы поля, пересечения, повтор', () => {
  const s0 = g.init(2, rng);
  const ok = fleetRows();
  assert.doesNotThrow(() => g.apply(s0, place(ok), 0, rng));
  throwsCode(() => g.apply(s0, place([{ r: 0, c: 6, dir: 'h' }, ...ok.slice(1)]), 0, rng), 'out_of_board'); // 5 клеток с 6-й: 6..10
  assert.doesNotThrow(() => g.apply(s0, place([{ r: 0, c: 5, dir: 'h' }, ...ok.slice(1)]), 0, rng)); // ровно до края
  throwsCode(() => g.apply(s0, place([{ r: 6, c: 0, dir: 'v' }, ...ok.slice(1)]), 0, rng), 'out_of_board');
  throwsCode(() => g.apply(s0, place([{ r: -1, c: 0, dir: 'h' }, ...ok.slice(1)]), 0, rng), 'out_of_board');
  throwsCode(() => g.apply(s0, place([{ r: 0, c: -1, dir: 'v' }, ...ok.slice(1)]), 0, rng), 'out_of_board');
  throwsCode(() => g.apply(s0, place([ok[0]!, { r: 0, c: 4, dir: 'v' }, ...ok.slice(2)]), 0, rng), 'overlap');
  const placed = g.apply(s0, place(ok), 0, rng);
  throwsCode(() => g.apply(placed, place(ok), 0, rng), 'already_placed');
  throwsCode(() => g.apply(s0, place(ok), 2, rng), 'bad_seat');
});

test('стрелять до конца расстановки нельзя; ход чужой — нельзя; повторный выстрел — нельзя', () => {
  const s0 = g.init(2, rng);
  throwsCode(() => g.apply(s0, { t: 'fire', cell: 0 }, 0, rng), 'wrong_phase');
  const one = g.apply(s0, place(fleetRows()), 0, rng);
  throwsCode(() => g.apply(one, { t: 'fire', cell: 0 }, 0, rng), 'wrong_phase');
  const s = started(3);
  const first = s.turn;
  throwsCode(() => g.apply(s, { t: 'fire', cell: 0 }, 1 - first, rng), 'not_your_turn');
  const s1 = g.apply(s, { t: 'fire', cell: 0 }, first, rng);
  const s2 = g.apply(s1, { t: 'fire', cell: 0 }, 1 - first, rng);
  throwsCode(() => g.apply(s2, { t: 'fire', cell: 0 }, first, rng), 'already_shot');
});

test('apply не меняет переданное состояние', () => {
  const s = started(5);
  const before = JSON.stringify(s);
  g.apply(s, { t: 'fire', cell: 42 }, s.turn, rng);
  assert.equal(JSON.stringify(s), before);
});

test('первого игрока определяет зерно: одинаковое зерно, одинаковый результат; разные зёрна дают обоих', () => {
  const firsts = new Set<number>();
  for (let seed = 1; seed <= 40; seed++) {
    const a = started(seed).turn;
    assert.equal(started(seed).turn, a);
    firsts.add(a);
  }
  assert.equal(firsts.size, 2);
});

/** Стрелок: перебирает клетки в случайном порядке. */
function playOut(seed: number): { s: State; shots: number } {
  const r = mulberry32(seed);
  let s = started(seed, randomFleet(r), randomFleet(r));
  const order = [[...Array(N * N).keys()], [...Array(N * N).keys()]];
  for (const o of order) for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j]!, o[i]!]; }
  let shots = 0;
  while (s.phase === 'firing') {
    const cell = order[s.turn]!.pop()!;
    s = g.apply(s, { t: 'fire', cell }, s.turn, r);
    shots++;
  }
  return { s, shots };
}

test('случайные партии: заканчиваются победой того, кто потопил все корабли соперника', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { s, shots } = playOut(seed);
    assert.equal(s.phase, 'over');
    assert.ok(shots >= 17 && shots <= 2 * N * N - 1, `выстрелов ${shots}`); // 17 клеток флота: быстрее победить нельзя
    const w = s.winner!;
    const loser = s.boards[1 - w]!;
    assert.ok(loser.ships!.every((sh) => sh.cells.every((c) => loser.shots.includes(c))));
    assert.deepEqual(g.outcome(s), { over: true, winner: w });
    assert.equal(g.turn(s), null);
    throwsCode(() => g.apply(s, { t: 'fire', cell: 0 }, 0, rng), 'wrong_phase');
  }
});

test('случайная расстановка всегда допустима и занимает 17 клеток', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const f = randomFleet(mulberry32(seed));
    const s = g.apply(g.init(2, rng), place(f), 0, rng);
    assert.equal(new Set(s.boards[0].ships!.flatMap((x) => x.cells)).size, 17);
  }
});

/** Все целые числа в виде, кроме служебных полей и собственных кораблей: это и есть всё, что игрок узнаёт о клетках. */
function visibleCells(v: unknown): Set<number> {
  const copy = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  for (const k of ['mine', 'turn', 'winner', 'phase', 'ready']) delete copy[k];
  const out = new Set<number>();
  const walk = (x: unknown): void => {
    if (typeof x === 'number') out.add(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.entries(x).forEach(([k, val]) => (k === 'hit' ? undefined : walk(val)));
  };
  walk(copy);
  return out;
}

function assertNoLeak(v: ReturnType<typeof g.view>, s: State, seat: number): void {
  const enemy = s.boards[1 - seat]!;
  assert.equal(v.boards[1 - seat]!.ships, undefined, 'чужая расстановка не открыта');
  const allowed = new Set([...enemy.shots, ...enemy.ships!.filter((sh) => sh.cells.every((c) => enemy.shots.includes(c))).flatMap((sh) => sh.cells), ...s.boards[seat]!.shots]);
  for (const c of visibleCells(v)) assert.ok(allowed.has(c), `клетка ${c} чужого корабля попала в вид, хотя по ней не стреляли`);
}

test('скрытая информация: до конца партии игрок узнаёт о чужих кораблях только то, во что попал или что потопил', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = mulberry32(seed);
    let s = started(seed, randomFleet(r), randomFleet(r));
    const orders = [[...Array(N * N).keys()], [...Array(N * N).keys()]];
    while (s.phase === 'firing') {
      for (const seat of [0, 1]) {
        const v = g.view(s, seat);
        assertNoLeak(v, s, seat);
        assert.deepEqual(v.mine, s.boards[seat]!.ships!.map((x) => x.cells), 'свои корабли видны полностью');
      }
      const spectator = g.view(s, null);
      assert.equal('mine' in spectator, false);
      const allShots = new Set([...s.boards[0].shots, ...s.boards[1].shots]);
      for (const c of visibleCells(spectator)) assert.ok(allShots.has(c) || s.boards.some((b) => b.ships!.some((sh) => sh.cells.includes(c) && sh.cells.every((x) => b.shots.includes(x)))), 'зритель видит клетку без выстрела');
      const order = orders[s.turn]!;
      const cell = order.splice(Math.floor(r() * order.length), 1)[0]!;
      s = g.apply(s, { t: 'fire', cell }, s.turn, r);
    }
    const end = g.view(s, 0);
    assert.ok(end.boards[0].ships && end.boards[1].ships, 'после конца открыты обе расстановки');
  }
});

test('мутация: проверка утечки действительно срабатывает на «дырявом» виде', () => {
  const s = started(4);
  const good = g.view(s, 0);
  assert.doesNotThrow(() => assertNoLeak(good, s, 0));
  const leakCells = { ...good, boards: [good.boards[0], { ...good.boards[1], leaked: s.boards[1].ships![0]!.cells }] } as unknown as typeof good;
  assert.throws(() => assertNoLeak(leakCells, s, 0));
  const leakShips = { ...good, boards: [good.boards[0], { ...good.boards[1], ships: s.boards[1].ships!.map((x) => x.cells) }] } as unknown as typeof good;
  assert.throws(() => assertNoLeak(leakShips, s, 0));
});

test('метаморфный тест приватности: вид игрока не зависит от расстановки соперника, пока нет попаданий', () => {
  const mine = fleetRows();
  const a = started(9, mine, randomFleet(mulberry32(100)));
  const b = started(9, mine, randomFleet(mulberry32(200)));
  assert.equal(a.turn, b.turn);
  assert.notDeepEqual(a.boards[1].ships, b.boards[1].ships, 'расстановки соперника действительно разные');
  assert.deepEqual(g.view(a, 0), g.view(b, 0));
  assert.deepEqual(g.view(a, 1).boards, g.view(b, 1).boards);
  assert.deepEqual(g.view(a, null), g.view(b, null));
  // промах мимо обеих расстановок: вид стреляющего остаётся одинаковым
  const miss = [...Array(N * N).keys()].find((c) => ![a, b].some((st) => st.boards[1 - a.turn]!.ships!.some((x) => x.cells.includes(c))))!;
  const a1 = g.apply(a, { t: 'fire', cell: miss }, a.turn, rng);
  const b1 = g.apply(b, { t: 'fire', cell: miss }, b.turn, rng);
  assert.deepEqual(g.view(a1, a.turn), g.view(b1, b.turn));
});

test('потопленный корабль открывается целиком, раненый нет', () => {
  let cur = started(11, fleetRows(), fleetRows()); // корабли в строках 0, 2, 4, 6, 8; длина первого 5
  const shooter = cur.turn;
  let free = 90; // клетки ряда 9 пусты у обоих
  const shoot = (cell: number): void => {
    cur = g.apply(cur, { t: 'fire', cell }, cur.turn, rng);
  };
  for (let c = 0; c < 4; c++) {
    shoot(c); // четыре клетки из пяти
    shoot(free++);
  }
  let enemyBoard = g.view(cur, shooter).boards[1 - shooter]!;
  assert.equal(enemyBoard.sunk.length, 0);
  assert.equal(enemyBoard.shots.filter((x) => x.hit).length, 4);
  shoot(4);
  shoot(free++);
  enemyBoard = g.view(cur, shooter).boards[1 - shooter]!;
  assert.deepEqual(enemyBoard.sunk, [[0, 1, 2, 3, 4]]);
});
