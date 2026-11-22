// Комната: места, токены, ход партии, журнал действий. Чистая логика без Cloudflare: её же запускают тесты и Durable Object.

import { mulberry32, seedFor } from './rng.ts';
import { GameError } from './types.ts';
import type { GameDef, Outcome } from './types.ts';

export const LIMITS = { name: 20, log: 2000, code: 5 } as const;

export interface Seat {
  name: string;
  /** SHA-256 секретного токена места: сам токен сервер не хранит. */
  tokenHash: string;
}
export interface LogEntry {
  seat: number;
  action: unknown;
}
export interface Room {
  v: 1;
  game: string;
  code: string;
  phase: 'lobby' | 'playing' | 'over';
  seats: Seat[];
  seed: number;
  createdAt: number;
  lastActivity: number;
  /** Состояние игры (JSON); до старта отсутствует. */
  state?: unknown;
  /** Число применённых действий; номер очередного действия = seq + 1. */
  seq: number;
  log: LogEntry[];
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 16): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без O/0 и I/1: код диктуют вслух
export function randomCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(LIMITS.code)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
export const isCode = (s: string): boolean => new RegExp(`^[${CODE_ALPHABET}]{${LIMITS.code}}$`).test(s);

export function createRoom(def: GameDef<any, any, any>, code: string, now: number, seed: number): Room {
  return { v: 1, game: def.id, code, phase: 'lobby', seats: [], seed: seed >>> 0, createdAt: now, lastActivity: now, seq: 0, log: [] };
}

function cleanName(v: unknown): string {
  if (typeof v !== 'string') throw new GameError('bad_name', 'Имя должно быть строкой.');
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s) throw new GameError('bad_name', 'Введите имя.');
  if ([...s].length > LIMITS.name) throw new GameError('bad_name', `Имя длиннее ${LIMITS.name} знаков.`);
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      throw new GameError('bad_name', 'В имени есть управляющие или невидимые символы.');
    }
  }
  return s;
}

/** Место по токену, или -1. */
export async function identify(room: Room, token: unknown): Promise<number> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 64) return -1;
  const h = await sha256(token);
  return room.seats.findIndex((s) => s.tokenHash === h);
}

export interface Joined {
  seat: number;
  /** Выдаётся только при первом входе: повторно сервер его не покажет. */
  token?: string;
}

/** Вход в комнату: по токену возвращает прежнее место (переподключение), иначе занимает новое в лобби. */
export async function join(room: Room, def: GameDef<any, any, any>, name: unknown, token: unknown, now: number): Promise<Joined> {
  const known = await identify(room, token);
  if (known >= 0) return { seat: known };
  if (room.phase !== 'lobby') throw new GameError('game_started', 'Игра уже началась: новых игроков не принимают. Можно смотреть как зритель.');
  if (room.seats.length >= def.maxPlayers) throw new GameError('room_full', 'Все места заняты.');
  const clean = cleanName(name);
  if (room.seats.some((s) => s.name.toLowerCase() === clean.toLowerCase())) throw new GameError('name_taken', 'Такое имя уже есть в комнате.');
  const t = randomToken(16);
  room.seats.push({ name: clean, tokenHash: await sha256(t) });
  room.lastActivity = now;
  return { seat: room.seats.length - 1, token: t };
}

export function start(room: Room, def: GameDef<any, any, any>, seat: number, now: number): void {
  if (seat !== 0) throw new GameError('not_host', 'Начать игру может только создатель комнаты.');
  if (room.phase !== 'lobby') throw new GameError('already_started', 'Игра уже началась.');
  if (room.seats.length < def.minPlayers) throw new GameError('not_enough_players', `Нужно игроков: не меньше ${def.minPlayers}.`);
  room.state = def.init(room.seats.length, mulberry32(seedFor(room.seed, 0)));
  room.phase = 'playing';
  room.lastActivity = now;
}

/** Действие игрока. Состояние меняется только после успешной проверки; любая ошибка оставляет комнату как была. */
export function act(room: Room, def: GameDef<any, any, any>, seat: number, raw: unknown, now: number): void {
  if (room.phase !== 'playing') throw new GameError('not_playing', room.phase === 'lobby' ? 'Игра ещё не началась.' : 'Игра окончена.');
  if (room.log.length >= LIMITS.log) throw new GameError('log_full', 'Слишком длинная партия.');
  if (!Number.isInteger(seat) || seat < 0 || seat >= room.seats.length) throw new GameError('bad_seat', 'Нет такого места.');
  const action = def.parseAction(raw);
  const next = def.apply(room.state, action, seat, mulberry32(seedFor(room.seed, room.seq + 1)));
  room.state = next;
  room.seq += 1;
  room.log.push({ seat, action });
  room.lastActivity = now;
  if (def.outcome(next).over) room.phase = 'over';
}

export interface RoomView {
  code: string;
  game: string;
  phase: Room['phase'];
  seats: Array<{ name: string; online: boolean }>;
  /** Ваше место; null у зрителя. */
  you: number | null;
  host: boolean;
  seq: number;
  turn: number | null;
  outcome?: Outcome;
  /** Вид игры для вас; до старта отсутствует. */
  game_view?: unknown;
}

export function viewFor(room: Room, def: GameDef<any, any, any>, seat: number | null, online: boolean[]): RoomView {
  const v: RoomView = {
    code: room.code,
    game: room.game,
    phase: room.phase,
    seats: room.seats.map((s, i) => ({ name: s.name, online: online[i] ?? false })),
    you: seat,
    host: seat === 0,
    seq: room.seq,
    turn: room.phase === 'playing' ? def.turn(room.state) : null,
  };
  if (room.phase !== 'lobby') {
    v.outcome = def.outcome(room.state);
    v.game_view = def.view(room.state, seat);
  }
  return v;
}

/** Воспроизводит партию из зерна и журнала. Совпадение с хранимым состоянием доказывает, что журнал полон и игра детерминирована. */
export function replay(room: Room, def: GameDef<any, any, any>): unknown {
  if (room.phase === 'lobby') return undefined;
  let state = def.init(room.seats.length, mulberry32(seedFor(room.seed, 0)));
  room.log.forEach((e, i) => {
    state = def.apply(state, def.parseAction(e.action), e.seat, mulberry32(seedFor(room.seed, i + 1)));
  });
  return state;
}
