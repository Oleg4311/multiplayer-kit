// Клиент: комнаты по коду (#КОД), WebSocket с переподключением по токену, вид игры строится только из того, что прислал сервер.

import { FLEET, N, randomFleet } from './games/battleship.ts';
import type { Placement, View as BView } from './games/battleship.ts';
import { COLS, ROWS } from './games/connect4.ts';
import type { View as CView } from './games/connect4.ts';
import { isCode } from './kit/room.ts';
import type { RoomView } from './kit/room.ts';

const app = document.getElementById('app')!;
const toastEl = document.getElementById('toast')!;

type Attrs = Record<string, string | boolean | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...kids: Array<Node | string | null>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null) el.append(kid);
  return el;
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  setTimeout(() => toastEl.classList.remove('on'), 2600);
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* работает и без хранилища, но переподключиться к месту нельзя */
    }
  },
};

const GAME_TITLES: Record<string, string> = { battleship: 'Морской бой', connect4: 'Четыре в ряд' };

// ---------- главная ----------

function viewHome(message = ''): void {
  disconnect();
  const name = h('input', { id: 'name', maxlength: '20', autocomplete: 'nickname', value: store.get('mk:name') ?? '' }) as HTMLInputElement;
  const game = h('select', { id: 'game' }, ...Object.entries(GAME_TITLES).map(([id, t]) => h('option', { value: id }, t))) as HTMLSelectElement;
  const code = h('input', { id: 'code', maxlength: '5', autocapitalize: 'characters', autocomplete: 'off', placeholder: 'ABCDE' }) as HTMLInputElement;
  const problems = h('div', { class: 'banner', role: 'alert', hidden: message === '' }, message);
  const setProblem = (m: string): void => {
    problems.textContent = m;
    problems.toggleAttribute('hidden', m === '');
  };
  const needName = (): string | null => {
    const v = name.value.trim();
    if (!v) {
      setProblem('Введите имя.');
      name.focus();
      return null;
    }
    store.set('mk:name', v);
    return v;
  };
  show(
    h('section', { class: 'card' },
      h('h2', {}, 'Ваше имя'),
      problems,
      h('label', { for: 'name' }, 'Как вас называть в комнате'),
      name,
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Новая комната'),
      h('label', { for: 'game' }, 'Игра'),
      game,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', onclick: async () => {
        if (!needName()) return;
        try {
          const r = await fetch('/api/rooms', { method: 'POST', body: JSON.stringify({ game: game.value }) });
          const data = (await r.json()) as { code?: string; message?: string };
          if (!r.ok || !data.code) return setProblem(data.message ?? 'Не удалось создать комнату.');
          location.hash = '#' + data.code;
        } catch {
          setProblem('Нет связи с сервером.');
        }
      } }, 'Создать комнату')),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Войти по коду'),
      h('label', { for: 'code' }, 'Код комнаты (5 знаков)'),
      code,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => {
        const c = code.value.trim().toUpperCase();
        if (!isCode(c)) return setProblem('Код — пять знаков: буквы и цифры без O, 0, I, 1.');
        if (!needName()) return;
        location.hash = '#' + c;
      } }, 'Войти')),
    ),
  );
}

// ---------- соединение ----------

interface Conn {
  code: string;
  ws: WebSocket | null;
  view: RoomView | null;
  status: 'connecting' | 'online' | 'offline' | 'failed';
  attempts: number;
  everOpened: boolean;
  spectate: boolean;
  timer: number | undefined;
  ping: number | undefined;
  stopped: boolean;
}
let conn: Conn | null = null;
/** Расстановка, которую игрок выбирает локально, пока не нажал «Готов». */
let draft: Placement[] | null = null;

function disconnect(): void {
  if (!conn) return;
  conn.stopped = true;
  clearTimeout(conn.timer);
  clearInterval(conn.ping);
  conn.ws?.close(1000);
  conn = null;
  draft = null;
}

function wsUrl(code: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${code}/ws`;
}

function connect(c: Conn): void {
  if (c.stopped) return;
  c.status = 'connecting';
  render();
  const ws = new WebSocket(wsUrl(c.code));
  c.ws = ws;
  ws.addEventListener('open', () => {
    c.everOpened = true;
    c.attempts = 0;
    const token = store.get('mk:t:' + c.code);
    ws.send(JSON.stringify(c.spectate && !token ? { t: 'hello', spectate: true } : token ? { t: 'hello', token } : { t: 'hello', name: store.get('mk:name') ?? '' }));
    clearInterval(c.ping);
    c.ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25000);
  });
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') return;
    let m: { t: string; [k: string]: unknown };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.t === 'welcome') {
      if (typeof m.token === 'string') store.set('mk:t:' + c.code, m.token);
      c.status = 'online';
    } else if (m.t === 'state') {
      const same = JSON.stringify(c.view) === JSON.stringify(m.view) && c.status === 'online';
      c.view = m.view as RoomView;
      c.status = 'online';
      if (!same) render(); // без изменений страницу не перестраиваем: иначе клик может попасть в уже замещённую кнопку
    } else if (m.t === 'error') {
      const code = String(m.code);
      const text = String(m.message ?? 'Ошибка');
      if (c.view === null && ['name_taken', 'bad_name', 'room_full'].includes(code)) {
        disconnect();
        viewHome(text);
        return;
      }
      if (c.view === null && code === 'game_started') {
        c.stopped = true;
        show(h('section', { class: 'card' }, h('h2', {}, 'Игра уже идёт'), h('p', {}, text), h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', onclick: () => {
          const code2 = c.code;
          disconnect();
          conn = newConn(code2, true);
          connect(conn);
        } }, 'Смотреть как зритель'), h('a', { href: '#' }, 'На главную'))));
        return;
      }
      toast(text);
    }
  });
  ws.addEventListener('close', () => {
    clearInterval(c.ping);
    if (c.stopped) return;
    c.attempts += 1;
    if (!c.everOpened && c.attempts >= 3) {
      c.status = 'failed';
      render();
      return;
    }
    c.status = 'offline';
    render();
    c.timer = window.setTimeout(() => connect(c), Math.min(8000, 500 * 2 ** c.attempts));
  });
}

function newConn(code: string, spectate: boolean): Conn {
  return { code, ws: null, view: null, status: 'connecting', attempts: 0, everOpened: false, spectate, timer: undefined, ping: undefined, stopped: false };
}

function send(msg: unknown): void {
  if (conn?.ws?.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  else toast('Нет соединения: подождите переподключения.');
}

// ---------- отрисовка комнаты ----------

function show(...nodes: Node[]): void {
  app.replaceChildren(...nodes);
}

function render(): void {
  if (!conn) return;
  const c = conn;
  if (c.status === 'failed') {
    show(h('section', { class: 'card', role: 'alert' }, h('h2', {}, 'Комната недоступна'), h('p', {}, 'Код неверный, комната закрыта за неактивность или нет связи.'), h('p', {}, h('a', { href: '#' }, 'На главную'))));
    return;
  }
  const v = c.view;
  if (!v) {
    show(h('section', { class: 'card' }, h('p', {}, 'Подключаемся…')));
    return;
  }
  const link = location.origin + location.pathname + '#' + v.code;
  const online = c.status === 'online';
  const head = h('div', { class: 'status' },
    h('span', {}, GAME_TITLES[v.game] ?? v.game, ' · комната ', h('strong', {}, v.code)),
    h('span', { class: online ? 'pill on' : 'pill', role: 'status' }, online ? 'в сети' : c.status === 'connecting' ? 'подключение…' : 'нет связи, переподключаемся…'),
  );
  const seats = h('ul', { class: 'seats', 'aria-label': 'Игроки' }, ...v.seats.map((s, i) => h('li', {}, h('span', {}, s.name, v.you === i ? ' (вы)' : ''), h('span', { class: s.online ? 'pill on' : 'pill' }, s.online ? 'в сети' : 'не в сети'))));
  const parts: Node[] = [head];
  if (v.phase === 'lobby') {
    parts.push(
      h('section', { class: 'card' },
        h('h2', {}, 'Ожидание игроков'),
        h('p', { class: 'hint' }, 'Отправьте код или ссылку второму игроку.'),
        h('div', { class: 'code', 'aria-label': 'Код комнаты' }, v.code),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => void navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована'), () => toast(link)) }, 'Скопировать ссылку')),
        seats,
        v.host ? h('div', { class: 'actions' }, h('button', { class: 'primary', id: 'start', type: 'button', disabled: v.seats.length < 2, onclick: () => send({ t: 'start' }) }, v.seats.length < 2 ? 'Ждём второго игрока' : 'Начать игру')) : h('p', { class: 'hint' }, v.you === null ? 'Вы зритель.' : 'Игру начнёт создатель комнаты.'),
      ),
    );
  } else if (v.game === 'battleship') parts.push(...renderBattleship(v, v.game_view as BView));
  else if (v.game === 'connect4') parts.push(...renderConnect4(v, v.game_view as CView));
  if (v.phase !== 'lobby') parts.push(h('section', { class: 'card' }, h('h2', {}, 'Игроки'), seats), h('p', {}, h('a', { href: '#' }, 'Выйти на главную')));
  show(...parts);
}

const ROW_LETTERS = 'ABCDEFGHIJ';
const cellName = (i: number): string => `${ROW_LETTERS[Math.floor(i / N)]}${(i % N) + 1}`;

function banner(v: RoomView, text: string, win = false): HTMLElement {
  return h('div', { class: win ? 'banner win' : 'banner', role: 'status', 'data-testid': 'banner' }, text);
}

function nameOf(v: RoomView, seat: number | null | undefined): string {
  return seat === null || seat === undefined ? '' : (v.seats[seat]?.name ?? '');
}

function renderBattleship(v: RoomView, g: BView): Node[] {
  const out: Node[] = [];
  const me = v.you;
  const players = me === 0 || me === 1;

  if (g.phase === 'placing') {
    const placed = players && g.ready[me!];
    if (players && !placed) {
      draft ??= randomFleet(Math.random);
      const cells = new Set(draft.flatMap((p, i) => Array.from({ length: FLEET[i]! }, (_, k) => (p.r + (p.dir === 'v' ? k : 0)) * N + p.c + (p.dir === 'h' ? k : 0))));
      out.push(
        h('section', { class: 'card' },
          h('h2', {}, 'Расставьте корабли'),
          h('p', { class: 'hint' }, 'Нажимайте «Другая расстановка», пока она не понравится. Соперник её не увидит.'),
          grid((i) => ({ cls: cells.has(i) ? 'ship' : '', label: `${cellName(i)}: ${cells.has(i) ? 'корабль' : 'вода'}` }), null, 'Ваше поле'),
          h('div', { class: 'actions' },
            h('button', { type: 'button', id: 'reshuffle', onclick: () => { draft = randomFleet(Math.random); render(); } }, 'Другая расстановка'),
            h('button', { class: 'primary', type: 'button', id: 'ready', onclick: () => { send({ t: 'act', a: { t: 'place', ships: draft } }); } }, 'Готов'),
          ),
        ),
      );
    } else {
      out.push(banner(v, players ? 'Корабли расставлены. Ждём соперника.' : `Расстановка: ${g.ready.filter(Boolean).length} из 2 готовы.`));
      if (players) out.push(h('section', { class: 'card' }, h('h2', {}, 'Ваше поле'), ownGrid(g, me!)));
    }
    return out;
  }

  const myTurn = players && g.phase === 'firing' && g.turn === me;
  if (g.phase === 'over') {
    const w = g.winner;
    out.push(banner(v, w === me ? 'Вы победили!' : `Победил(а) ${nameOf(v, w)}.`, w === me));
  } else if (players) out.push(banner(v, myTurn ? 'Ваш ход: выберите клетку на поле соперника.' : `Ходит ${nameOf(v, g.turn)}.`));
  else out.push(banner(v, `Ходит ${nameOf(v, g.turn)}.`));

  const boardFor = (seat: number, clickable: boolean): Node => {
    const b = g.boards[seat]!;
    const shots = new Map(b.shots.map((s) => [s.cell, s.hit]));
    const sunk = new Set(b.sunk.flat());
    const revealed = new Set((b.ships ?? []).flat());
    const mine = seat === me ? new Set((g.mine ?? []).flat()) : new Set<number>();
    return grid(
      (i) => {
        const shot = shots.get(i);
        const state = shot === undefined ? (mine.has(i) ? 'ваш корабль' : revealed.has(i) ? 'корабль' : 'неизвестно') : sunk.has(i) ? 'потоплен' : shot ? 'попадание' : 'промах';
        const cls = shot === undefined ? (mine.has(i) ? 'ship' : revealed.has(i) ? 'reveal' : '') : sunk.has(i) ? 'hit sunk' : shot ? 'hit' : 'miss';
        return { cls, label: `${cellName(i)}: ${state}`, disabled: !clickable || !myTurn || shot !== undefined };
      },
      clickable ? (i) => send({ t: 'act', a: { t: 'fire', cell: i } }) : null,
      seat === me ? 'Ваше поле' : clickable ? 'Поле соперника' : `Поле ${nameOf(v, seat)}`,
    );
  };
  if (players) {
    out.push(
      h('div', { class: 'boards' },
        h('section', { class: 'card' }, h('h2', {}, `Поле соперника: ${nameOf(v, 1 - me!)}`), boardFor(1 - me!, true)),
        h('section', { class: 'card' }, h('h2', {}, 'Ваше поле'), boardFor(me!, false)),
      ),
    );
  } else {
    out.push(h('div', { class: 'boards' }, ...[0, 1].map((s) => h('section', { class: 'card' }, h('h2', {}, nameOf(v, s)), boardFor(s, false)))));
  }
  return out;
}

function ownGrid(g: BView, me: number): Node {
  const mine = new Set((g.mine ?? []).flat());
  return grid((i) => ({ cls: mine.has(i) ? 'ship' : '', label: `${cellName(i)}: ${mine.has(i) ? 'ваш корабль' : 'вода'}` }), null, 'Ваше поле');
}

interface CellSpec {
  cls: string;
  label: string;
  disabled?: boolean;
}
function grid(spec: (i: number) => CellSpec, onClick: ((i: number) => void) | null, label: string): HTMLElement {
  const cells: Node[] = [];
  for (let i = 0; i < N * N; i++) {
    const s = spec(i);
    cells.push(h('button', { type: 'button', class: s.cls, 'aria-label': s.label, 'data-cell': String(i), disabled: onClick === null || s.disabled === true, onclick: () => onClick?.(i) }));
  }
  return h('div', { class: 'grid', role: 'group', 'aria-label': label }, ...cells);
}

function renderConnect4(v: RoomView, g: CView): Node[] {
  const me = v.you;
  const players = me === 0 || me === 1;
  const out: Node[] = [];
  const over = v.outcome?.over === true;
  if (over) out.push(banner(v, g.winner === null ? 'Ничья.' : g.winner === me ? 'Вы победили!' : `Победил(а) ${nameOf(v, g.winner)}.`, g.winner === me));
  else out.push(banner(v, players && g.turn === me ? 'Ваш ход: выберите столбец.' : `Ходит ${nameOf(v, g.turn)}.`));
  const full = (c: number): boolean => g.cells[c] !== -1;
  out.push(
    h('section', { class: 'card' },
      h('div', { class: 'colhead' }, ...Array.from({ length: COLS }, (_, c) => h('button', { type: 'button', 'aria-label': `Бросить в столбец ${c + 1}`, 'data-col': String(c), disabled: over || !players || g.turn !== me || full(c), onclick: () => send({ t: 'act', a: { t: 'drop', col: c } }) }, String(c + 1)))),
      h('div', { class: 'c4', role: 'img', 'aria-label': 'Игровое поле' }, ...Array.from({ length: ROWS * COLS }, (_, i) => h('button', { type: 'button', disabled: true, tabindex: '-1', class: `${g.cells[i] === -1 ? '' : 'p' + g.cells[i]}${g.line?.includes(i) ? ' win' : ''}`, 'aria-hidden': 'true' }))),
      h('p', { class: 'hint' }, `Жёлтые: ${nameOf(v, 0)}, красные: ${nameOf(v, 1)}.`),
    ),
  );
  return out;
}

// ---------- маршрутизация ----------

function route(): void {
  const code = location.hash.replace(/^#/, '').toUpperCase();
  if (!code) return viewHome();
  if (!isCode(code)) return viewHome('Неверный код комнаты.');
  if (conn?.code === code && !conn.stopped) return;
  disconnect();
  const hasToken = store.get('mk:t:' + code) !== null;
  const name = store.get('mk:name');
  if (!hasToken && !name) {
    viewHome('Введите имя и войдите по коду ещё раз.');
    return;
  }
  conn = newConn(code, false);
  connect(conn);
}

window.addEventListener('hashchange', route);
route();
