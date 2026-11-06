import { test, expect, type Page } from '@playwright/test';
import { mockExplorer } from './explorer-mock.ts';

const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c';
const M = '0x6B4E065d08D2cC7723635c6df0CC5268C706cD93';
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

const create = async (page: Page, desc: string, price: string, due: string) => {
  await page.getByTestId('inv-customer').fill(ACME);
  await page.getByTestId('inv-payee').fill(PAYEE);
  await page.getByTestId('inv-supplier-name').fill('Bluejay Logistics');
  await page.getByTestId('inv-line-desc-0').fill(desc);
  await page.getByTestId('inv-line-price-0').fill(price);
  await page.getByTestId('inv-due').fill(due);
  await page.getByTestId('inv-create').click();
  await expect(page.getByTestId('inv-link')).toBeVisible();
};
const isoDay = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('/invoices/: unpaid invoices say when they are due; "Send reminder" offers WhatsApp, email and Copy, and remembers it; Home links to the overdue list', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockExplorer(page);
  await page.addInitScript(() => { if (!localStorage.getItem('tazor.company.v1')) localStorage.setItem('tazor.company.v1', 'bluejay'); });
  await page.goto('/invoices/');
  await create(page, 'Freight', '10', isoDay(3));
  await create(page, 'Storage', '2.5', isoDay(-2));

  const list = page.locator('[data-testid="inv-row"]');
  const overdue = list.filter({ hasText: 'Storage' });
  await expect(overdue.getByTestId('inv-due-label')).toHaveText('Overdue by 2 days');
  await expect(list.filter({ hasText: 'Freight' }).getByTestId('inv-due-label')).toHaveText('Due in 3 days');

  await overdue.getByTestId('reminder-open').click();
  const panel = page.getByTestId('reminder-panel');
  await expect(panel).toBeVisible();
  const text = (await panel.getByTestId('reminder-text').textContent())!;
  expect(text).toContain('2.50 USDT');
  expect(text).toMatch(/It was due on \d+ \w+ \d{4}\./);
  expect(text).toContain('/pay/');
  expect(text).toContain('please ignore');
  await expect(panel.getByTestId('reminder-whatsapp')).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=Hello/);
  await expect(panel.getByTestId('reminder-email')).toHaveAttribute('href', /^mailto:\?subject=Reminder%3A%20invoice%20/);
  await panel.getByTestId('reminder-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await page.keyboard.press('Escape');
  await expect(overdue.getByTestId('reminder-last')).toHaveText('Reminded just now');
  await page.reload();
  await expect(page.locator('[data-testid="inv-row"]').filter({ hasText: 'Storage' }).getByTestId('reminder-last')).toHaveText('Reminded just now');

  await page.goto('/');
  await expect(page.getByTestId('lane-overdue')).toHaveText('1 overdue');
  await page.getByTestId('lane-receivables').click();
  await expect(page).toHaveURL(/\/invoices\/\?tab=overdue/);
  await expect(page.getByTestId('inv-tab-overdue')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="inv-row"]')).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('/start/: a payment link can carry a due date, with a reminder for it; /paylink/ shows Due or Overdue', async ({ page }) => {
  await page.route('https://rpc.testnet.whitechain.io/**', (r) => r.fulfill(json({ jsonrpc: '2.0', id: 1, result: null })));
  await page.route('http://relayer.test/**', (r) => r.fulfill(json({ ok: true })));
  await page.goto('/start/');
  await page.getByTestId('start-name').fill('Chai Point');
  await page.getByTestId('start-wallet').fill(M);
  await page.getByTestId('start-due').fill(isoDay(2));
  await expect(page.getByTestId('start-due-label')).toHaveText('Due in 2 days');
  const link = (await page.getByTestId('start-copy-link').getAttribute('data-link'))!;
  expect(new URL(link).searchParams.get('due')).toBe(isoDay(2));
  await page.getByTestId('start-paylink').getByTestId('reminder-open').click();
  await expect(page.getByTestId('reminder-text')).toContainText('order ORDER-1001 from Chai Point for 10.00 USDT');
  await expect(page.getByTestId('reminder-text')).toContainText(link);

  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByTestId('pl-due')).toHaveAttribute('data-tone', 'soon');
  await expect(page.getByTestId('pl-due')).toContainText('in 2 days');
  await page.goto(`/paylink/?m=${M}&a=1&ref=X-1&due=${isoDay(-1)}`);
  await expect(page.getByTestId('pl-due')).toContainText('Overdue');
});
