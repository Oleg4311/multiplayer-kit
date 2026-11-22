// Морской бой: скрытая информация. Расстановка кораблей известна только её владельцу; противнику сервер отдаёт лишь результаты выстрелов
// и корабли, потопленные целиком. После конца партии открываются обе расстановки.

import { GameError } from '../kit/types.ts';
import type { GameDef, Outcome, Rng } from '../kit/types.ts';

export const N = 10;
export const FLEET = [5, 4, 3, 3, 2] as const;

export interface Ship {
  len: number;
  cells: number[];
}
export interface Board {
  ships: Ship[] | null;
  /** Клетки, по которым стреляли в эту доску, по порядку. */
  shots: number[];
}
export interface State {
  phase: 'placing' | 'firing' | 'over';
  boards: [Board, Board];
  turn: number;
  winner: number | null;
}
export type Placement = { r: number; c: number; dir: 'h' | 'v' };
export type Action = { t: 'place'; ships: Placement[] } | { t: 'fire'; cell: number };

export interface BoardView {
  shots: Array<{ cell: number; hit: boolean }>;
  /** Потопленные корабли целиком (открыты всем). */
  sunk: number[][];
  /** Все корабли: только после конца партии. */
  ships?: number[][];
}
export interface View {
  phase: State['phase'];
  turn: number | null;
  winner: number | null;
  ready: [boolean, boolean];
  boards: [BoardView, BoardView];
  /** Ваши корабли (и только ваши); у зрителя нет. */
  mine?: number[][];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function cellsOf(p: Placement, len: number): number[] {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) {
    const r = p.r + (p.dir === 'v' ? i : 0);
    const c = p.c + (p.dir === 'h' ? i : 0);
    if (p.r < 0 || p.c < 0 || r >= N || c >= N) throw new GameError('out_of_board', 'Корабль выходит за поле.');
    cells.push(r * N + c);
  }
  return cells;
}

function parseAction(raw: unknown): Action {
  if (typeof raw !== 'object' || raw === null) throw new GameError('bad_action', 'Нужен объект действия.');
  const a = raw as Record<string, unknown>;
  if (a['t'] === 'fire') {
    const cell = a['cell'];
    if (!isInt(cell) || cell < 0 || cell >= N * N) throw new GameError('bad_action', 'Клетка вне поля.');
    return { t: 'fire', cell };
  }
  if (a['t'] === 'place') {
    const ships = a['ships'];
    if (!Array.isArray(ships) || ships.length !== FLEET.length) throw new GameError('bad_action', `Нужно ровно ${FLEET.length} кораблей.`);
    return {
      t: 'place',
      ships: ships.map((s): Placement => {
        const o = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
        const { r, c, dir } = o;
        if (!isInt(r) || !isInt(c) || (dir !== 'h' && dir !== 'v')) throw new GameError('bad_action', 'Корабль задаётся клеткой r, c и направлением h или v.');
        return { r, c, dir };
      }),
    };
  }
  throw new GameError('bad_action', 'Неизвестное действие.');
}

function init(players: number): State {
  if (players !== 2) throw new GameError('players', 'Морской бой для двух игроков.');
  return { phase: 'placing', boards: [{ ships: null, shots: [] }, { ships: null, shots: [] }], turn: 0, winner: null };
}

function sunk(b: Board): Ship[] {
  return (b.ships ?? []).filter((s) => s.cells.every((c) => b.shots.includes(c)));
}

function apply(state: State, action: Action, seat: number, rng: Rng): State {
  if (seat !== 0 && seat !== 1) throw new GameError('bad_seat', 'Нет такого места.');
  const s: State = structuredClone(state);
  if (action.t === 'place') {
    if (s.phase !== 'placing') throw new GameError('wrong_phase', 'Расстановка уже закончена.');
    if (s.boards[seat]!.ships) throw new GameError('already_placed', 'Вы уже расставили корабли.');
    const taken = new Set<number>();
    const ships = action.ships.map((p, i) => {
      const cells = cellsOf(p, FLEET[i]!);
      for (const c of cells) {
        if (taken.has(c)) throw new GameError('overlap', 'Корабли пересекаются.');
        taken.add(c);
      }
      return { len: FLEET[i]!, cells };
    });
    s.boards[seat]!.ships = ships;
    if (s.boards[0].ships && s.boards[1].ships) {
      s.phase = 'firing';
      s.turn = rng() < 0.5 ? 0 : 1; // кто ходит первым, решает зерно комнаты
    }
    return s;
  }
  if (s.phase !== 'firing') throw new GameError('wrong_phase', s.phase === 'over' ? 'Игра окончена.' : 'Ещё идёт расстановка.');
  if (seat !== s.turn) throw new GameError('not_your_turn', 'Сейчас ход соперника.');
  const enemy = s.boards[1 - seat]!;
  if (enemy.shots.includes(action.cell)) throw new GameError('already_shot', 'Сюда вы уже стреляли.');
  enemy.shots.push(action.cell);
  if (sunk(enemy).length === FLEET.length) {
    s.phase = 'over';
    s.winner = seat;
  } else s.turn = 1 - seat;
  return s;
}

function boardView(b: Board, reveal: boolean): BoardView {
  const cells = new Set((b.ships ?? []).flatMap((s) => s.cells));
  return {
    shots: b.shots.map((cell) => ({ cell, hit: cells.has(cell) })),
    sunk: sunk(b).map((s) => [...s.cells]),
    ...(reveal && b.ships ? { ships: b.ships.map((s) => [...s.cells]) } : {}),
  };
}

function view(s: State, seat: number | null): View {
  const over = s.phase === 'over';
  return {
    phase: s.phase,
    turn: s.phase === 'firing' ? s.turn : null,
    winner: s.winner,
    ready: [s.boards[0].ships !== null, s.boards[1].ships !== null],
    boards: [boardView(s.boards[0], over), boardView(s.boards[1], over)],
    ...(seat === 0 || seat === 1 ? { mine: s.boards[seat]!.ships?.map((x) => [...x.cells]) ?? [] } : {}),
  };
}

function outcome(s: State): Outcome {
  return s.phase === 'over' ? { over: true, winner: s.winner ?? undefined } : { over: false };
}

/** Случайная допустимая расстановка (для кнопки «случайно» и тестов). */
export function randomFleet(rng: Rng): Placement[] {
  for (;;) {
    const taken = new Set<number>();
    const out: Placement[] = [];
    let ok = true;
    for (const len of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const dir = rng() < 0.5 ? 'h' : 'v';
        const r = Math.floor(rng() * (dir === 'v' ? N - len + 1 : N));
        const c = Math.floor(rng() * (dir === 'h' ? N - len + 1 : N));
        const cells = cellsOf({ r, c, dir }, len);
        if (cells.some((x) => taken.has(x))) continue;
        cells.forEach((x) => taken.add(x));
        out.push({ r, c, dir });
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return out;
  }
}

export const battleship: GameDef<State, Action, View> = {
  id: 'battleship',
  title: 'Морской бой',
  minPlayers: 2,
  maxPlayers: 2,
  init,
  parseAction,
  apply,
  view,
  outcome,
  turn: (s) => (s.phase === 'firing' ? s.turn : null),
};
