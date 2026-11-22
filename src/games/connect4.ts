// Четыре в ряд: игра с открытой информацией, показывает, что комнаты не привязаны к одной игре.

import { GameError } from '../kit/types.ts';
import type { GameDef, Outcome } from '../kit/types.ts';

export const COLS = 7;
export const ROWS = 6;

export interface State {
  /** Клетки по строкам сверху вниз (индекс r*COLS+c): -1 пусто, иначе место игрока. */
  cells: number[];
  turn: number;
  winner: number | null;
  draw: boolean;
  line: number[] | null;
}
export type Action = { t: 'drop'; col: number };
export type View = State;

function winLine(cells: number[], last: number): number[] | null {
  const p = cells[last]!;
  const r0 = Math.floor(last / COLS);
  const c0 = last % COLS;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
    const line = [last];
    for (const sign of [1, -1]) {
      for (let k = 1; k < 4; k++) {
        const r = r0 + dr * k * sign;
        const c = c0 + dc * k * sign;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || cells[r * COLS + c] !== p) break;
        line.push(r * COLS + c);
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b);
  }
  return null;
}

export const connect4: GameDef<State, Action, View> = {
  id: 'connect4',
  title: 'Четыре в ряд',
  minPlayers: 2,
  maxPlayers: 2,
  init(players) {
    if (players !== 2) throw new GameError('players', 'Игра для двух игроков.');
    return { cells: Array<number>(ROWS * COLS).fill(-1), turn: 0, winner: null, draw: false, line: null };
  },
  parseAction(raw) {
    const a = raw as { t?: unknown; col?: unknown } | null;
    if (!a || a.t !== 'drop' || typeof a.col !== 'number' || !Number.isInteger(a.col) || a.col < 0 || a.col >= COLS) throw new GameError('bad_action', 'Нужно действие drop со столбцом 0–6.');
    return { t: 'drop', col: a.col };
  },
  apply(state, action, seat) {
    if (state.winner !== null || state.draw) throw new GameError('over', 'Игра окончена.');
    if (seat !== state.turn) throw new GameError('not_your_turn', 'Сейчас ход соперника.');
    const s = structuredClone(state);
    let row = -1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (s.cells[r * COLS + action.col] === -1) {
        row = r;
        break;
      }
    }
    if (row < 0) throw new GameError('column_full', 'Столбец заполнен.');
    const idx = row * COLS + action.col;
    s.cells[idx] = seat;
    const line = winLine(s.cells, idx);
    if (line) {
      s.winner = seat;
      s.line = line;
    } else if (s.cells.every((c) => c !== -1)) s.draw = true;
    else s.turn = 1 - seat;
    return s;
  },
  view: (s) => structuredClone(s),
  outcome(s): Outcome {
    return s.winner !== null ? { over: true, winner: s.winner } : s.draw ? { over: true } : { over: false };
  },
  turn: (s) => (s.winner !== null || s.draw ? null : s.turn),
};
