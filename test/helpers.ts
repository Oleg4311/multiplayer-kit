// Общие помощники сетевых тестов: запуск Miniflare и клиент WebSocket, копящий все сырые кадры.
import assert from 'node:assert/strict';
import { buildWorker, makeMiniflare } from '../scripts/mf.mjs';

export interface Server {
  mf: Awaited<ReturnType<typeof makeMiniflare>>;
  base: string;
  wsBase: string;
}

export async function startServer(bindings: Record<string, string>): Promise<Server> {
  buildWorker();
  const mf = makeMiniflare({ bindings });
  const base = (await mf.ready).toString().replace(/\/$/, '');
  return { mf, base, wsBase: base.replace('http', 'ws') };
}

export async function createRoom(srv: Server, game = 'battleship'): Promise<string> {
  const r = await fetch(`${srv.base}/api/rooms`, { method: 'POST', body: JSON.stringify({ game }) });
  assert.equal(r.status, 201);
  return ((await r.json()) as { code: string }).code;
}

/** Клиент: копит все сырые кадры и позволяет ждать нужный. */
export class Client {
  ws: WebSocket;
  frames: string[] = [];
  msgs: any[] = [];
  waiters: Array<() => void> = [];
  closed: { code: number } | null = null;
  token?: string;
  seat?: number | null;

  constructor(srv: Server, code: string) {
    this.ws = new WebSocket(`${srv.wsBase}/api/rooms/${code}/ws`);
    this.ws.addEventListener('message', (e) => {
      const text = String(e.data);
      this.frames.push(text);
      if (text === 'pong') return this.wake();
      const m = JSON.parse(text);
      if (m.t === 'welcome') {
        this.token = m.token ?? this.token;
        this.seat = m.seat;
      }
      this.msgs.push(m);
      this.wake();
    });
    this.ws.addEventListener('close', (e) => {
      this.closed = { code: e.code };
      this.wake();
    });
  }
  private wake(): void {
    this.waiters.splice(0).forEach((w) => w());
  }
  async open(): Promise<this> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((res, rej) => {
        this.ws.addEventListener('open', () => res(), { once: true });
        this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
      });
    }
    return this;
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  async until<T>(pick: () => T | undefined, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = pick();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error('таймаут ожидания кадра');
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 100);
      });
    }
  }
  /** Ждёт сообщение типа t, пришедшее после текущего момента. */
  async next(t: string, from = this.msgs.length): Promise<any> {
    return this.until(() => this.msgs.slice(from).find((m) => m.t === t));
  }
  state(): any {
    return [...this.msgs].reverse().find((m) => m.t === 'state')?.view;
  }
  async hello(name: string, token?: string): Promise<this> {
    await this.open();
    const from = this.msgs.length;
    this.send(token ? { t: 'hello', token } : { t: 'hello', name });
    await this.next('welcome', from);
    await this.until(() => this.state());
    return this;
  }
  async act(a: unknown): Promise<any> {
    const from = this.msgs.length;
    this.send({ t: 'act', a });
    return this.until(() => this.msgs.slice(from).find((m) => m.t === 'state' || m.t === 'error'));
  }
  close(): void {
    this.ws.close(1000);
  }
}

