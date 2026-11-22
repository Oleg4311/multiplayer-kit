// Контракт игры для комнаты. Игра описывается чистыми функциями над JSON-совместимым состоянием:
// сервер хранит состояние, проверяет каждое действие и сам решает, что показать каждому игроку (`view`).

export type Rng = () => number;

/** Ошибка правил: сообщение безопасно показать игроку, код стабилен для клиента. */
export class GameError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Outcome {
  over: boolean;
  /** Место победителя; undefined при ничьей или пока игра идёт. */
  winner?: number;
}

export interface GameDef<S, A, V> {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  /** Начальное состояние для `players` игроков. Случайность только через `rng`: тогда партия воспроизводится из журнала. */
  init(players: number, rng: Rng): S;
  /** Разбор непроверенного ввода от клиента. Бросает GameError. */
  parseAction(raw: unknown): A;
  /** Применяет действие игрока на месте `seat`. Не меняет `state`, возвращает новое. Бросает GameError. */
  apply(state: S, action: A, seat: number, rng: Rng): S;
  /** Что видит игрок на месте `seat` (null: зритель). Скрытая информация сюда попадать не должна. */
  view(state: S, seat: number | null): V;
  outcome(state: S): Outcome;
  /** Чей ход (null: ходят одновременно или игра окончена). */
  turn(state: S): number | null;
}
