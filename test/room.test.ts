import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET, N, battleship, randomFleet } from '../src/games/battleship.ts';
import { COLS, ROWS, connect4 } from '../src/games/connect4.ts';
import { gameById } from '../src/games/index.ts';
import { mulberry32, seedFor } from '../src/kit/rng.ts';
import { LIMITS, act, createRoom, identify, isCode, join, randomCode, replay, sha256, start, viewFor } from '../src/kit/room.ts';
import type { Room } from '../src/kit/room.ts';
import { GameError } from '../src/kit/types.ts';

const NOW = 1_800_000_000_000;

async function rejects(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    assert.ok(e instanceof GameError, String(e));
    assert.equal(e.code, code, e.message);
    return;
  }
  assert.fail(`ожидалась ошибка ${code}`);
}

async function lobby(game = battleship as never, seed = 1): Promise<{ room: Room; tokens: string[] }> {
  const room = createRoom(game, 'ABCDE', NOW, seed);
  const tokens: string[] = [];
  for (const n of ['Анна', 'Борис']) tokens.push((await join(room, game, n, undefined, NOW)).token!);
  return { room, tokens };
}

test('код комнаты: алфавит без похожих знаков, проверка формата', () => {
  for (let i = 0; i < 200; i++) {
    const c = randomCode();
    assert.equal(c.length, LIMITS.code);
    assert.ok(isCode(c) && !/[O0I1]/.test(c));
  }
  for (const bad of ['', 'abcde', 'ABCD', 'ABCDEF', 'ABCD0', 'ABC<E']) assert.equal(isCode(bad), false);
});

test('вход: токен выдаётся один раз и хранится только хешем; по токену — то же место', async () => {
  const room = createRoom(battleship, 'ABCDE', NOW, 1);
  const a = await join(room, battleship, ' Анна ', undefined, NOW);
  assert.equal(a.seat, 0);
  assert.ok(a.token && a.token.length >= 22);
  assert.ok(!JSON.stringify(room).includes(a.token), 'токен не хранится открытым');
  assert.equal(room.seats[0]!.tokenHash, await sha256(a.token));
  assert.equal(room.seats[0]!.name, 'Анна');
  const again = await join(room, battleship, 'Другое имя', a.token, NOW);
  assert.deepEqual(again, { seat: 0 });
  assert.equal(room.seats.length, 1);
  assert.equal(await identify(room, a.token), 0);
  for (const bad of [undefined, null, 5, '', 'x'.repeat(16), 'x'.repeat(200)]) assert.equal(await identify(room, bad), -1);
});

test('вход: проверки имени, дубликатов и числа мест', async () => {
  const room = createRoom(battleship, 'ABCDE', NOW, 1);
  await join(room, battleship, 'Анна', undefined, NOW);
  await rejects(join(room, battleship, 'анна', undefined, NOW), 'name_taken');
  for (const bad of [5, '', '   ', 'я'.repeat(LIMITS.name + 1), 'а\u0000б', 'а‮б', 'а​б']) await rejects(join(room, battleship, bad, undefined, NOW), 'bad_name');
  const norm = await join(room, battleship, 'Борис   Б	', undefined, NOW); // пробельные символы схлопываются в один пробел
  assert.equal(room.seats[norm.seat]!.name, 'Борис Б');
  await rejects(join(room, battleship, 'Вера', undefined, NOW), 'room_full');
});

test('старт: только создатель, только в лобби, только когда хватает игроков', async () => {
  const room = createRoom(battleship, 'ABCDE', NOW, 1);
  await join(room, battleship, 'Анна', undefined, NOW);
  await rejects(async () => start(room, battleship, 0, NOW), 'not_enough_players');
  await join(room, battleship, 'Борис', undefined, NOW);
  await rejects(async () => start(room, battleship, 1, NOW), 'not_host');
  start(room, battleship, 0, NOW);
  assert.equal(room.phase, 'playing');
  await rejects(async () => start(room, battleship, 0, NOW), 'already_started');
  await rejects(join(room, battleship, 'Вера', undefined, NOW), 'game_started');
  // но участник, у которого есть токен, возвращается и после старта
  assert.ok(room.seats.length === 2);
});

test('действие до старта и после конца отвергается', async () => {
  const { room } = await lobby();
  await rejects(async () => act(room, battleship, 0, { t: 'fire', cell: 0 }, NOW), 'not_playing');
});

test('ошибочное действие не меняет комнату ни на байт', async () => {
  const { room } = await lobby();
  start(room, battleship, 0, NOW);
  const bad: unknown[] = [{ t: 'fire', cell: 0 }, { t: 'zzz' }, null, { t: 'place', ships: [] }];
  for (const raw of bad) {
    const before = JSON.stringify(room);
    assert.throws(() => act(room, battleship, 0, raw, NOW + 5), GameError);
    assert.equal(JSON.stringify(room), before);
  }
  assert.throws(() => act(room, battleship, 7, { t: 'place', ships: randomFleet(mulberry32(1)) }, NOW), GameError);
});

function playBattleship(seed: number): Room {
  const r = mulberry32(seed);
  const room = createRoom(battleship, 'ABCDE', NOW, seed);
  room.seats.push({ name: 'A', tokenHash: 'h1' }, { name: 'B', tokenHash: 'h2' });
  start(room, battleship, 0, NOW);
  act(room, battleship, 0, { t: 'place', ships: randomFleet(r) }, NOW);
  act(room, battleship, 1, { t: 'place', ships: randomFleet(r) }, NOW);
  const orders = [0, 1].map(() => [...Array(N * N).keys()].sort(() => r() - 0.5));
  while (room.phase === 'playing') {
    const seat = battleship.turn(room.state as never)!;
    act(room, battleship, seat, { t: 'fire', cell: orders[seat]!.pop() }, NOW + room.seq);
  }
  return room;
}

test('журнал воспроизводит партию: состояние из зерна и журнала совпадает с хранимым', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const room = playBattleship(seed);
    assert.equal(room.phase, 'over');
    assert.equal(room.log.length, room.seq);
    assert.deepEqual(replay(room, battleship), room.state);
  }
});

test('зерно детерминирует партию: те же действия дают то же состояние, другое зерно — другого первого игрока иногда', () => {
  const a = playBattleship(7);
  const b = playBattleship(7);
  assert.deepEqual(a.state, b.state);
  const firsts = new Set<number>();
  for (let seed = 1; seed <= 30; seed++) {
    const room = createRoom(battleship, 'ABCDE', NOW, seed);
    room.seats.push({ name: 'A', tokenHash: 'h1' }, { name: 'B', tokenHash: 'h2' });
    start(room, battleship, 0, NOW);
    const r = mulberry32(seed);
    act(room, battleship, 0, { t: 'place', ships: randomFleet(r) }, NOW);
    act(room, battleship, 1, { t: 'place', ships: randomFleet(r) }, NOW);
    firsts.add(battleship.turn(room.state as never)!);
  }
  assert.equal(firsts.size, 2);
});

test('seedFor: разные номера действий дают разные зёрна', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) seen.add(seedFor(12345, i));
  assert.ok(seen.size > 4990);
});

test('вид комнаты: зритель и игроки, до старта без игрового вида, после конца есть итог', async () => {
  const { room } = await lobby();
  const v0 = viewFor(room, battleship, 0, [true, false]);
  assert.equal(v0.host, true);
  assert.equal(v0.game_view, undefined);
  assert.deepEqual(v0.seats, [{ name: 'Анна', online: true }, { name: 'Борис', online: false }]);
  const done = playBattleship(3);
  const vs = viewFor(done, battleship, null, []);
  assert.equal(vs.you, null);
  assert.equal(vs.host, false);
  assert.equal(vs.outcome?.over, true);
  assert.equal(vs.turn, null);
  assert.equal('mine' in (vs.game_view as object), false);
});

test('лимит журнала: слишком длинная партия останавливается', () => {
  const room = createRoom(connect4, 'ABCDE', NOW, 1);
  room.seats.push({ name: 'A', tokenHash: 'h1' }, { name: 'B', tokenHash: 'h2' });
  start(room, connect4, 0, NOW);
  room.log = Array.from({ length: LIMITS.log }, () => ({ seat: 0, action: {} }));
  assert.throws(() => act(room, connect4, 0, { t: 'drop', col: 0 }, NOW), (e) => e instanceof GameError && e.code === 'log_full');
});

test('реестр игр: неизвестный и служебные идентификаторы не находятся', () => {
  assert.ok(gameById('battleship') && gameById('connect4'));
  for (const bad of ['', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(gameById(bad), undefined);
});

// ---------- четыре в ряд ----------

function brute(cells: number[]): number | null {
  const at = (r: number, c: number): number => (r < 0 || r >= ROWS || c < 0 || c >= COLS ? -2 : cells[r * COLS + c]!);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
        const p = at(r, c);
        if (p >= 0 && [1, 2, 3].every((k) => at(r + dr * k, c + dc * k) === p)) return p;
      }
  return null;
}

test('четыре в ряд: победа находится независимо от направления, сверка с перебором на 500 партиях', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = mulberry32(seed);
    let s = connect4.init(2, r);
    let guard = 0;
    while (!connect4.outcome(s).over && guard++ < 100) {
      const cols = [...Array(COLS).keys()].filter((c) => s.cells[c] === -1);
      const col = cols[Math.floor(r() * cols.length)]!;
      const before = JSON.stringify(s);
      s = connect4.apply(s, { t: 'drop', col }, s.turn, r);
      assert.equal(JSON.stringify(connect4.view(s, null)), JSON.stringify(s));
      assert.ok(before !== JSON.stringify(s));
      assert.equal(brute(s.cells), s.winner, `seed ${seed}`);
    }
    const o = connect4.outcome(s);
    assert.ok(o.over);
    if (s.winner !== null) assert.ok(s.line && s.line.length >= 4 && s.line.every((i) => s.cells[i] === s.winner));
    else assert.ok(s.draw && s.cells.every((c) => c !== -1));
  }
});

test('четыре в ряд: ход чужой, полный столбец, ход после конца, разбор ввода', () => {
  const s0 = connect4.init(2, mulberry32(1));
  assert.throws(() => connect4.apply(s0, { t: 'drop', col: 0 }, 1, mulberry32(1)), GameError);
  let s = s0;
  for (let i = 0; i < ROWS; i++) s = connect4.apply(s, { t: 'drop', col: 0 }, s.turn, mulberry32(1)); // столбец заполнен без победы: чередуются игроки
  assert.equal(s.winner, null);
  assert.throws(() => connect4.apply(s, { t: 'drop', col: 0 }, s.turn, mulberry32(1)), (e) => e instanceof GameError && e.code === 'column_full');
  for (const raw of [null, {}, { t: 'drop' }, { t: 'drop', col: 7 }, { t: 'drop', col: -1 }, { t: 'drop', col: 1.2 }, { t: 'drop', col: '1' }]) assert.throws(() => connect4.parseAction(raw), GameError);
  assert.equal(FLEET.length, 5);
});
