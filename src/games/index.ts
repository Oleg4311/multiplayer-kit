import type { GameDef } from '../kit/types.ts';
import { battleship } from './battleship.ts';
import { connect4 } from './connect4.ts';

export const GAMES: Record<string, GameDef<any, any, any>> = { battleship, connect4 };
export const gameById = (id: string): GameDef<any, any, any> | undefined => (Object.hasOwn(GAMES, id) ? GAMES[id] : undefined);
