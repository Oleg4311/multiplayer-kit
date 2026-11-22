// Worker + Durable Object «Комната»: один объект на комнату, WebSocket с гибернацией, сервер решает всё.
// Клиент присылает намерения (hello, start, act), сервер проверяет и рассылает каждому его собственный вид.

import { gameById } from '../src/games/index.ts';
import { LIMITS, act, createRoom, isCode, join, identify, randomCode, start, viewFor } from '../src/kit/room.ts';
import type { Room } from '../src/kit/room.ts';
import { randomSeed } from '../src/kit/rng.ts';
import { GameError } from '../src/kit/types.ts';

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Дополнительные адреса страниц (через запятую), которым разрешены запросы; своя страница разрешена всегда. */
  ALLOWED_ORIGINS?: string;
  /** Срок жизни комнаты после последнего действия, мс (для тестов; по умолчанию сутки). */
  ROOM_TTL_MS?: string;
  /** Сообщений в секунду на сокет (для тестов; по умолчанию 8, всплеск в 2,5 раза больше). */
  RATE_PER_SEC?: string;
}

const MAX_MESSAGE = 2048;
const MAX_SOCKETS = 12;
const DEFAULT_TTL_MS = 24 * 3600 * 1000; // комната живёт сутки после последнего действия
const DEFAULT_RATE = 8;
const CLOSE_AFTER_STRIKES = 50;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/** Запрос из браузера допустим со своей страницы или из списка; без Origin (не браузер) пропускаем. Это защита от чужих страниц, а не аутентификация. */
function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  if (origin === new URL(req.url).origin) return true;
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === '/api/health') return json({ ok: true });
      if (!originAllowed(req, env)) return json({ error: 'forbidden_origin', message: 'Запрос с чужой страницы.' }, 403);
      if (url.pathname === '/api/rooms') {
        if (req.method !== 'POST') return json({ error: 'method_not_allowed', message: 'Метод не поддерживается.' }, 405);
        const len = Number(req.headers.get('content-length') ?? '0');
        if (len > 1024) return json({ error: 'too_large', message: 'Слишком большой запрос.' }, 413);
        const body = (await req.json().catch(() => null)) as { game?: unknown } | null;
        const gameId = typeof body?.game === 'string' ? body.game : '';
        if (!gameById(gameId)) return json({ error: 'unknown_game', message: 'Неизвестная игра.' }, 400);
        for (let i = 0; i < 5; i++) {
          const code = randomCode();
          const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch('https://room/init', { method: 'POST', body: JSON.stringify({ game: gameId, code }) });
          if (res.status === 201) return json({ code, game: gameId }, 201);
          if (res.status !== 409) return json({ error: 'internal', message: 'Не удалось создать комнату.' }, 500);
        }
        return json({ error: 'busy', message: 'Не удалось подобрать код комнаты, повторите.' }, 503);
      }
      const m = /^\/api\/rooms\/([A-Z0-9]+)\/ws$/.exec(url.pathname);
      if (m && isCode(m[1]!)) {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'upgrade_required', message: 'Нужен WebSocket.' }, 426);
        return env.ROOM.get(env.ROOM.idFromName(m[1]!)).fetch(req);
      }
      return json({ error: 'not_found', message: 'Не найдено.' }, 404);
    } catch {
      return json({ error: 'internal', message: 'Внутренняя ошибка.' }, 500);
    }
  },
};

interface Attachment {
  /** null: зритель; undefined до приветствия. */
  seat?: number | null;
}

export class RoomDO {
  private readonly ctx: DurableObjectState;
  private readonly ttl: number;
  private readonly rate: number;
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number; strikes: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    const t = Number(env.ROOM_TTL_MS);
    this.ttl = Number.isFinite(t) && t >= 500 ? t : DEFAULT_TTL_MS;
    const r = Number(env.RATE_PER_SEC);
    this.rate = Number.isFinite(r) && r > 0 ? r : DEFAULT_RATE;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private load(): Promise<Room | undefined> {
    return this.ctx.storage.get<Room>('room');
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/init') {
      if (await this.load()) return json({ error: 'exists' }, 409);
      const { game, code } = (await req.json()) as { game: string; code: string };
      const def = gameById(game);
      if (!def) return json({ error: 'unknown_game' }, 400);
      const now = Date.now();
      await this.ctx.storage.put('room', createRoom(def, code, now, randomSeed()));
      await this.ctx.storage.setAlarm(now + this.ttl);
      return json({ ok: true }, 201);
    }
    const room = await this.load();
    if (!room) return json({ error: 'not_found', message: 'Комнаты нет: код неверный или она закрыта.' }, 404);
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return json({ error: 'room_busy', message: 'В комнате слишком много подключений.' }, 503);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({} satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* сокет уже закрыт */
    }
  }

  private fail(ws: WebSocket, e: unknown): void {
    if (e instanceof GameError) this.send(ws, { t: 'error', code: e.code, message: e.message });
    else this.send(ws, { t: 'error', code: 'internal', message: 'Внутренняя ошибка.' });
  }

  /** Каждому сокету уходит его собственный вид: игроки и зрители получают разное. */
  private broadcast(room: Room, closing?: WebSocket): void {
    const def = gameById(room.game)!;
    const sockets = this.ctx.getWebSockets().filter((w) => w !== closing);
    const online: boolean[] = room.seats.map(() => false);
    for (const ws of sockets) {
      const seat = (ws.deserializeAttachment() as Attachment | null)?.seat;
      if (typeof seat === 'number') online[seat] = true;
    }
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.seat === undefined) continue; // ещё не поздоровался
      this.send(ws, { t: 'state', view: viewFor(room, def, a.seat, online) });
    }
  }

  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    const capacity = this.rate * 2.5;
    const b = this.buckets.get(ws) ?? { tokens: capacity, at: now, strikes: 0 };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * this.rate);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    b.strikes += 1;
    if (b.strikes >= CLOSE_AFTER_STRIKES) ws.close(1008, 'Слишком много сообщений');
    return false;
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (!this.allow(ws)) {
      this.send(ws, { t: 'error', code: 'rate_limited', message: 'Слишком часто.' });
      return;
    }
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'Сообщение должно быть текстом не длиннее 2 КБ.' });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      msg = parsed as Record<string, unknown>;
    } catch {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'Нужен JSON-объект.' });
      return;
    }
    const room = await this.load();
    if (!room) {
      ws.close(1000, 'Комната закрыта');
      return;
    }
    const def = gameById(room.game)!;
    const att = (ws.deserializeAttachment() as Attachment | null) ?? {};
    try {
      const now = Date.now();
      switch (msg['t']) {
        case 'hello': {
          if (att.seat !== undefined) throw new GameError('already_hello', 'Вы уже вошли.');
          let seat: number | null;
          let token: string | undefined;
          const known = await identify(room, msg['token']);
          if (known >= 0) seat = known;
          else if (msg['spectate'] === true) seat = null;
          else {
            const j = await join(room, def, msg['name'], undefined, now);
            seat = j.seat;
            token = j.token;
            await this.ctx.storage.put('room', room);
          }
          ws.serializeAttachment({ seat } satisfies Attachment);
          this.send(ws, { t: 'welcome', seat, ...(token ? { token } : {}) });
          this.broadcast(room);
          return;
        }
        case 'start':
          if (typeof att.seat !== 'number') throw new GameError('not_player', 'Зрители не могут начинать игру.');
          start(room, def, att.seat, now);
          break;
        case 'act':
          if (typeof att.seat !== 'number') throw new GameError('not_player', 'Зрители не могут ходить.');
          act(room, def, att.seat, msg['a'], now);
          break;
        default:
          throw new GameError('bad_message', 'Неизвестный тип сообщения.');
      }
      await this.ctx.storage.put('room', room);
      await this.ctx.storage.setAlarm(room.lastActivity + this.ttl);
      this.broadcast(room);
    } catch (e) {
      this.fail(ws, e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      /* уже закрыт */
    }
    await this.presence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.presence(ws);
  }

  /** Обновляет у всех отметки «в сети»: после закрытия сокет ещё может числиться в списке, поэтому исключаем закрытые. */
  private async presence(closing: WebSocket): Promise<void> {
    const room = await this.load();
    if (room) this.broadcast(room, closing);
  }

  async alarm(): Promise<void> {
    const room = await this.load();
    if (room && Date.now() < room.lastActivity + this.ttl) {
      await this.ctx.storage.setAlarm(room.lastActivity + this.ttl);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Комната закрыта за неактивностью');
      } catch {
        /* ничего */
      }
    }
    await this.ctx.storage.deleteAll();
  }
}

export { LIMITS };
