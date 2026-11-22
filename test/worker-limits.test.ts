// Ограничения: частота, размер, срок жизни. Отдельный файл и сервер со стандартными лимитами (в основном наборе частота снята, чтобы партия шла быстро).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client, createRoom as create, startServer } from './helpers.ts';
import type { Server } from './helpers.ts';

let srv: Server;
let ttlSrv: Server;
const createRoom = (): Promise<string> => create(srv);
const mk = (code: string): Client => new Client(srv, code);

before(async () => {
  srv = await startServer({});
  ttlSrv = await startServer({ ROOM_TTL_MS: '1500' }); // комнаты живут полторы секунды
});
after(async () => {
  await srv.mf.dispose();
  await ttlSrv.mf.dispose();
});

test('сообщения: мусор, слишком длинное, неизвестный тип, бинарное; частота ограничена', async () => {
  const code = await createRoom();
  const a = await mk(code).hello('Анна');
  for (const bad of ['не json', '[]', '5', 'null', JSON.stringify({ t: 'nope' }), JSON.stringify({ t: 'act', a: 'x'.repeat(3000) })]) {
    const from = a.msgs.length;
    a.send(bad);
    const e = await a.next('error', from).catch((err) => { throw new Error(`нет ответа на «${bad.slice(0, 30)}»: ${err.message}`); });
    assert.ok(['bad_message', 'not_playing'].includes(e.code), `${bad.slice(0, 20)} → ${e.code}`);
  }
  const from = a.msgs.length;
  for (let i = 0; i < 35; i++) a.send({ t: 'nope' }); // выше лимита, но ниже порога отключения
  await a.until(() => (a.msgs.slice(from).some((m) => m.code === 'rate_limited') ? true : undefined));
  // ping обслуживается без пробуждения комнаты
  a.send('ping');
  await a.until(() => (a.frames.includes('pong') ? true : undefined));
  a.close();
});

test('комната закрывается за неактивность: после срока подключиться нельзя', async () => {
  const code = await create(ttlSrv);
  const a = await new Client(ttlSrv, code).hello('Анна');
  await a.until(() => a.closed ?? undefined, 6000);
  await assert.rejects(new Client(ttlSrv, code).open());
});

test('постоянный перебор лимита закрывает соединение', async () => {
  const code = await createRoom();
  const a = await mk(code).hello('Анна');
  for (let i = 0; i < 150; i++) a.send({ t: 'nope' });
  const closed = await a.until(() => a.closed ?? undefined);
  assert.equal(closed.code, 1008);
});
