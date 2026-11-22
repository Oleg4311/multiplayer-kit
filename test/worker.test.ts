// Тесты настоящего собранного Worker в Miniflare: реальные WebSocket-соединения, две стороны, скрытая информация в кадрах.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { N, randomFleet } from '../src/games/battleship.ts';
import type { Placement, View } from '../src/games/battleship.ts';
import { mulberry32 } from '../src/kit/rng.ts';
import { Client, createRoom as create, startServer } from './helpers.ts';
import type { Server } from './helpers.ts';

let srv: Server;
const base = (): string => srv.base;
const createRoom = (game?: string): Promise<string> => create(srv, game);
const mk = (code: string): Client => new Client(srv, code);

before(async () => {
  srv = await startServer({ RATE_PER_SEC: '1000' });
});
after(async () => {
  await srv.mf.dispose();
});

test('здоровье, создание комнаты и ошибки HTTP', async () => {
  assert.equal((await fetch(`${base()}/api/health`)).status, 200);
  const code = await createRoom();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.equal((await fetch(`${base()}/api/rooms`, { method: 'POST', body: JSON.stringify({ game: 'nope' }) })).status, 400);
  assert.equal((await fetch(`${base()}/api/rooms`, { method: 'POST', body: '{не json' })).status, 400);
  assert.equal((await fetch(`${base()}/api/rooms`, { method: 'POST', body: JSON.stringify({ game: '__proto__' }) })).status, 400);
  assert.equal((await fetch(`${base()}/api/rooms`)).status, 405);
  assert.equal((await fetch(`${base()}/api/rooms`, { method: 'POST', body: 'x'.repeat(2000) })).status, 413);
  assert.equal((await fetch(`${base()}/api/nope`)).status, 404);
  assert.equal((await srv.mf.dispatchFetch(`${base()}/api/rooms/ABCDE/ws`)).status, 426);
  assert.equal((await srv.mf.dispatchFetch(`${base()}/api/rooms/abcde/ws`, { headers: { upgrade: 'websocket' } })).status, 404);
  const html = await fetch(`${base()}/`);
  assert.ok([200, 404].includes(html.status));
});

test('чужая страница не может создавать комнаты и подключаться', async () => {
  const evil = { origin: 'https://evil.example' };
  const r = await fetch(`${base()}/api/rooms`, { method: 'POST', headers: evil, body: JSON.stringify({ game: 'battleship' }) });
  assert.equal(r.status, 403);
  const code = await createRoom();
  const ws = await srv.mf.dispatchFetch(`${base()}/api/rooms/${code}/ws`, { headers: { upgrade: 'websocket', ...evil } });
  assert.equal(ws.status, 403);
  const own = await fetch(`${base()}/api/rooms`, { method: 'POST', headers: { origin: base() }, body: JSON.stringify({ game: 'battleship' }) });
  assert.equal(own.status, 201);
});

test('подключение к несуществующей комнате не открывается', async () => {
  const c = mk('ZZZZZ');
  await assert.rejects(c.open());
});

async function fullBattleship(seed: number, opts: { dropMidGame?: boolean } = {}) {
  const code = await createRoom();
  const fa = randomFleet(mulberry32(seed));
  const fb = randomFleet(mulberry32(seed + 1000));
  const a = await mk(code).hello('Анна');
  const b = await mk(code).hello('Борис');
  await a.until(() => (a.state()?.seats.length === 2 ? true : undefined));
  assert.deepEqual([a.seat, b.seat], [0, 1]);
  const startFrom = a.msgs.length;
  a.send({ t: 'start' });
  await a.next('state', startFrom);
  await a.until(() => (a.state()?.phase === 'playing' ? true : undefined));
  await a.act({ t: 'place', ships: fa });
  const afterB = await b.act({ t: 'place', ships: fb });
  assert.equal(afterB.t, 'state');
  await a.until(() => (a.state()?.game_view?.phase === 'firing' ? true : undefined));
  return { code, a, b, fa, fb };
}

const cellsOf = (fleet: Placement[], lens = [5, 4, 3, 3, 2]): number[][] => fleet.map((p, i) => Array.from({ length: lens[i]! }, (_, k) => (p.r + (p.dir === 'v' ? k : 0)) * N + p.c + (p.dir === 'h' ? k : 0)));

test('полная партия по сети: победитель определён сервером, враг не видит расстановку до конца', async () => {
  const { a, b, fa, fb } = await fullBattleship(5);
  const players = [{ c: a, fleet: fa }, { c: b, fleet: fb }];
  const r = mulberry32(77);
  const orders = [0, 1].map(() => [...Array(N * N).keys()].sort(() => r() - 0.5));
  let guard = 0;
  while (players[0]!.c.state().phase === 'playing' && guard++ < 250) {
    const seat = players[0]!.c.state().turn as number;
    const reply = await players[seat]!.c.act({ t: 'fire', cell: orders[seat]!.pop() });
    assert.equal(reply.t, 'state', JSON.stringify(reply));
    await players[1 - seat]!.c.until(() => (players[1 - seat]!.c.state().seq === reply.view.seq ? true : undefined));
  }
  assert.equal(a.state().phase, 'over');
  assert.equal(b.state().phase, 'over');
  assert.equal(a.state().outcome.winner, b.state().outcome.winner);

  // анализ всех кадров, полученных игроком A до конца партии: ни одной клетки корабля B, по которой не стреляли
  const enemyCells = cellsOf(fb).flat();
  for (const [me, other, otherFleet, name] of [[a, b, fb, 'A'], [b, a, fa, 'B']] as const) {
    const mineCells = cellsOf(me === a ? fa : fb);
    for (const m of me.msgs.filter((x) => x.t === 'state')) {
      const v = m.view;
      if (v.phase !== 'playing') continue;
      assert.deepEqual(v.game_view.mine ?? [], v.game_view.phase === 'placing' && !v.game_view.mine?.length ? [] : mineCells, `${name}: свои корабли`);
      const gv = v.game_view as View;
      const enemy = gv.boards[1 - v.you]!;
      assert.equal(enemy.ships, undefined, `${name}: чужая расстановка в кадре`);
      const shot = new Set(enemy.shots.map((s) => s.cell));
      const sunkCells = new Set(enemy.sunk.flat());
      const hidden = cellsOf(otherFleet).flat().filter((c) => !shot.has(c) && !sunkCells.has(c));
      const text = JSON.stringify({ ...gv, mine: undefined });
      for (const c of hidden) assert.ok(!new RegExp(`[\\[,]${c}[\\],]`).test(text) || [...gv.boards[0]!.shots, ...gv.boards[1]!.shots].some((s) => s.cell === c), `${name}: клетка ${c} чужого корабля в кадре`);
    }
    void other;
  }
  void enemyCells;
  // токены не попадают в кадры состояния, только в welcome владельцу
  for (const c of [a, b]) {
    for (const f of c.frames.filter((x) => !x.includes('"welcome"'))) {
      assert.ok(!f.includes(a.token!) && !f.includes(b.token!), 'токен в чужом кадре');
    }
  }
  const end = a.state().game_view as View;
  assert.ok(end.boards[0].ships && end.boards[1].ships, 'после конца открыты расстановки');
  a.close();
  b.close();
});

test('ошибочные действия: чужой ход, повторный выстрел, мусор: состояние не меняется', async () => {
  const { a, b } = await fullBattleship(8);
  const seq = a.state().seq;
  const turn = a.state().turn as number;
  const [mover, waiter] = turn === 0 ? [a, b] : [b, a];
  const wrong = await waiter.act({ t: 'fire', cell: 0 });
  assert.equal(wrong.t, 'error');
  assert.equal(wrong.code, 'not_your_turn');
  const bad = await mover.act({ t: 'fire', cell: 1000 });
  assert.equal(bad.code, 'bad_action');
  const junk = await mover.act('строка');
  assert.equal(junk.t, 'error');
  assert.equal(mover.state().seq, seq);
  assert.equal(waiter.state().seq, seq);
  const ok = await mover.act({ t: 'fire', cell: 0 });
  assert.equal(ok.view.seq, seq + 1);
  await waiter.until(() => (waiter.state().seq === seq + 1 ? true : undefined));
  const dup = await waiter.act({ t: 'fire', cell: 0 });
  assert.equal(dup.t, 'state');
  await mover.until(() => (mover.state().seq === seq + 2 ? true : undefined)); // иначе ответ на следующее действие можно спутать с рассылкой
  const again = await mover.act({ t: 'fire', cell: 0 });
  assert.equal(again.code, 'already_shot');
  a.close();
  b.close();
});

test('переподключение по токену: то же место, партия продолжается, присутствие видно сопернику', async () => {
  const { code, a, b } = await fullBattleship(9);
  const token = a.token!;
  a.close();
  await b.until(() => (b.state()?.seats[0].online === false ? true : undefined));
  const a2 = await mk(code).hello('', token);
  assert.equal(a2.seat, 0);
  assert.equal(a2.token, undefined, 'повторно токен не выдаётся');
  assert.equal(a2.state().game_view.phase, 'firing');
  assert.ok(a2.state().game_view.mine.length === 5, 'свои корабли восстановлены');
  await b.until(() => (b.state()?.seats[0].online === true ? true : undefined));
  const stranger = mk(code);
  await stranger.open();
  const sf = stranger.msgs.length;
  stranger.send({ t: 'hello', token: 'x'.repeat(22) }); // неизвестный токен без имени: места не получает
  assert.equal((await stranger.next('error', sf)).code, 'game_started');
  stranger.close();
  b.close();
  a2.close();
});

test('зритель видит партию без чужих секретов и не может ходить; в начатую игру нового игрока не пускают', async () => {
  const { code, a, b } = await fullBattleship(10);
  const s = mk(code);
  await s.open();
  const from = s.msgs.length;
  s.send({ t: 'hello', spectate: true });
  await s.next('welcome', from);
  await s.until(() => s.state());
  assert.equal(s.seat, null);
  assert.equal('mine' in s.state().game_view, false);
  assert.equal(s.state().you, null);
  const r = await s.act({ t: 'fire', cell: 0 });
  assert.equal(r.code, 'not_player');
  const late = mk(code);
  await late.open();
  const f2 = late.msgs.length;
  late.send({ t: 'hello', name: 'Опоздавший' });
  const err = await late.next('error', f2);
  assert.equal(err.code, 'game_started');
  for (const c of [a, b, s, late]) c.close();
});

test('лобби: третий игрок не помещается, стартует только создатель, одинаковое имя занято', async () => {
  const code = await createRoom();
  const a = await mk(code).hello('Анна');
  const dup = mk(code);
  await dup.open();
  let from = dup.msgs.length;
  dup.send({ t: 'hello', name: 'анна' });
  assert.equal((await dup.next('error', from)).code, 'name_taken');
  const b = await mk(code).hello('Борис');
  const c = mk(code);
  await c.open();
  from = c.msgs.length;
  c.send({ t: 'hello', name: 'Вера' });
  assert.equal((await c.next('error', from)).code, 'room_full');
  from = b.msgs.length;
  b.send({ t: 'start' });
  assert.equal((await b.next('error', from)).code, 'not_host');
  from = a.msgs.length;
  a.send({ t: 'hello', name: 'ещё раз' });
  assert.equal((await a.next('error', from)).code, 'already_hello');
  for (const x of [a, b, c, dup]) x.close();
});

test('четыре в ряд работает на той же комнате без изменений кода', async () => {
  const code = await createRoom('connect4');
  const a = await mk(code).hello('Анна');
  const b = await mk(code).hello('Борис');
  a.send({ t: 'start' });
  await a.until(() => (a.state()?.phase === 'playing' ? true : undefined));
  // игра по очереди: A ставит в столбец 0, B в 1, пока A не соберёт четыре подряд по вертикали
  for (let i = 0; i < 3; i++) {
    assert.equal((await a.act({ t: 'drop', col: 0 })).t, 'state');
    await b.until(() => (b.state().game_view.turn === 1 ? true : undefined));
    assert.equal((await b.act({ t: 'drop', col: 1 })).t, 'state');
    await a.until(() => (a.state().game_view.turn === 0 ? true : undefined));
  }
  await a.act({ t: 'drop', col: 0 });
  await a.until(() => (a.state().phase === 'over' ? true : undefined));
  assert.equal(a.state().outcome.winner, 0);
  a.close();
  b.close();
});
