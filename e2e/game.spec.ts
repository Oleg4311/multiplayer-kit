import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function player(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, permissions: ['clipboard-read', 'clipboard-write'] });
  return ctx.newPage();
}

/** Создаёт комнату от имени игрока и возвращает код. */
async function createRoom(page: Page, name: string, game: string): Promise<string> {
  await page.goto('./');
  await page.getByLabel('Как вас называть').fill(name);
  await page.getByLabel('Игра').selectOption(game);
  await page.getByRole('button', { name: 'Создать комнату' }).click();
  await expect(page.getByText('Ожидание игроков')).toBeVisible();
  return (await page.locator('.code').innerText()).trim();
}

async function joinRoom(page: Page, name: string, code: string): Promise<void> {
  await page.goto('./');
  await page.getByLabel('Как вас называть').fill(name);
  await page.getByLabel('Код комнаты').fill(code);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Ожидание игроков')).toBeVisible();
}

async function startBattle(browser: Browser, baseURL: string | undefined) {
  const a = await player(browser, baseURL);
  const b = await player(browser, baseURL);
  const code = await createRoom(a, 'Анна', 'battleship');
  await joinRoom(b, 'Борис', code);
  await expect(a.getByRole('button', { name: 'Начать игру' })).toBeEnabled();
  await expect(b.getByText('Игру начнёт создатель комнаты.')).toBeVisible();
  await a.getByRole('button', { name: 'Начать игру' }).click();
  for (const p of [a, b]) {
    await expect(p.getByRole('heading', { name: 'Расставьте корабли' })).toBeVisible();
    await p.getByRole('button', { name: 'Готов' }).click();
  }
  return { a, b, code };
}

test('морской бой: две вкладки играют партию до победы, чужие корабли в странице не появляются', async ({ browser, baseURL }) => {
  const { a, b } = await startBattle(browser, baseURL);
  const pages = [a, b];
  const nextCell = [0, 0];
  let finished = false;
  for (let step = 0; step < 220 && !finished; step++) {
    for (const [i, p] of pages.entries()) {
      const banner = (await p.getByTestId('banner').innerText()).trim();
      if (/победил/i.test(banner)) {
        finished = true;
        break;
      }
      if (banner.startsWith('Ваш ход')) {
        const enemy = p.getByRole('group', { name: 'Поле соперника' });
        // до конца партии на поле соперника нет ни одного «корабля»: только неизвестно, попадание, промах, потоплен
        const labels = await enemy.locator('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
        expect(labels.filter((l) => l.includes('корабль'))).toEqual([]);
        const cell = nextCell[i]!++;
        await expect(async () => {
          if ((await p.getByTestId('banner').innerText()).startsWith('Ваш ход')) await enemy.locator(`[data-cell="${cell}"]`).click({ timeout: 3000 });
          await expect(p.getByTestId('banner')).not.toContainText('Ваш ход', { timeout: 3000 });
        }).toPass({ timeout: 15_000 });
      }
    }
  }
  expect(finished).toBe(true);
  const texts = await Promise.all(pages.map((p) => p.getByTestId('banner').innerText()));
  expect(texts.filter((t) => t.includes('Вы победили')).length).toBe(1);
  // после конца открыты обе расстановки
  // (у победителя на поле соперника остаются непобитые клетки: ищем на обеих страницах)
  const unshot = await Promise.all(pages.map((p) => p.getByRole('group', { name: 'Поле соперника' }).locator('button[aria-label$=": корабль"]').count()));
  expect(unshot[0]! + unshot[1]!).toBeGreaterThan(0);
});

test('перезагрузка вкладки возвращает на то же место с теми же кораблями', async ({ browser, baseURL }) => {
  const { a, b } = await startBattle(browser, baseURL);
  await expect(a.getByTestId('banner')).toContainText(/Ваш ход|Ходит/);
  const before = await a.getByRole('group', { name: 'Ваше поле' }).locator('button[aria-label$="ваш корабль"]').count();
  expect(before).toBe(17);
  await a.reload();
  await expect(a.getByTestId('banner')).toContainText(/Ваш ход|Ходит/);
  expect(await a.getByRole('group', { name: 'Ваше поле' }).locator('button[aria-label$="ваш корабль"]').count()).toBe(17);
  await expect(b.getByText('в сети').first()).toBeVisible();
});

test('опоздавший не может занять место, но может смотреть партию', async ({ browser, baseURL }) => {
  const { code } = await startBattle(browser, baseURL);
  const late = await player(browser, baseURL);
  await joinRoomExpectingStarted(late, code);
  await late.getByRole('button', { name: 'Смотреть как зритель' }).click();
  await expect(late.getByRole('group', { name: 'Поле' }).first()).toBeVisible();
  await expect(late.getByRole('group', { name: 'Поле' }).locator('button[aria-label$="ваш корабль"]')).toHaveCount(0);
});

async function joinRoomExpectingStarted(page: Page, code: string): Promise<void> {
  await page.goto('./');
  await page.getByLabel('Как вас называть').fill('Опоздавший');
  await page.getByLabel('Код комнаты').fill(code);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Игра уже идёт')).toBeVisible();
}

test('имя занято и неверный код объясняются на главной', async ({ browser, baseURL }) => {
  const a = await player(browser, baseURL);
  const code = await createRoom(a, 'Анна', 'battleship');
  const b = await player(browser, baseURL);
  await b.goto('./');
  await b.getByLabel('Как вас называть').fill('анна');
  await b.getByLabel('Код комнаты').fill(code);
  await b.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(b.getByRole('alert')).toContainText('имя уже есть');
  await b.getByLabel('Код комнаты').fill('AB0DE');
  await b.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(b.getByRole('alert')).toContainText('пять знаков');
});

test('четыре в ряд: тот же интерфейс комнат, игра по очереди до победы', async ({ browser, baseURL }) => {
  const a = await player(browser, baseURL);
  const b = await player(browser, baseURL);
  const code = await createRoom(a, 'Анна', 'connect4');
  await joinRoom(b, 'Борис', code);
  await a.getByRole('button', { name: 'Начать игру' }).click();
  for (let i = 0; i < 3; i++) {
    await expect(a.getByTestId('banner')).toContainText('Ваш ход');
    await a.locator('[data-col="0"]').click();
    await expect(b.getByTestId('banner')).toContainText('Ваш ход');
    await b.locator('[data-col="1"]').click();
  }
  await expect(a.getByTestId('banner')).toContainText('Ваш ход');
  await a.locator('[data-col="0"]').click();
  await expect(a.getByTestId('banner')).toContainText('Вы победили');
  await expect(b.getByTestId('banner')).toContainText('Победил(а) Анна');
});

test('доступность: главная, лобби и поле боя без серьёзных нарушений', async ({ browser, baseURL }) => {
  const a = await player(browser, baseURL);
  await a.goto('./');
  expect((await new AxeBuilder({ page: a }).analyze()).violations.map((v) => v.id)).toEqual([]);
  await createRoom(a, 'Анна', 'battleship');
  expect((await new AxeBuilder({ page: a }).analyze()).violations.map((v) => v.id)).toEqual([]);
  const { a: pa } = await startBattle(browser, baseURL);
  expect((await new AxeBuilder({ page: pa }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test('нет горизонтальной прокрутки на телефоне', async ({ browser, baseURL }) => {
  const { a } = await startBattle(browser, baseURL);
  const overflow = await a.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
