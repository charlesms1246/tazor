import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';
const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const TX_IN = `0x${'aa'.repeat(32)}`;
const TX_OUT = `0x${'bb'.repeat(32)}`;
const item = (tx: string, from: string, to: string, value: string, timestamp: string) => ({
  timestamp, log_index: 0, transaction_hash: tx, from: { hash: from }, to: { hash: to }, total: { value }, token: { address_hash: USDT },
});

async function mockExplorer(page: Page, responses: { status: number; body: unknown }[]) {
  let n = 0;
  await page.route('**/api/v2/addresses/**', async (route) => {
    const r = responses[Math.min(n++, responses.length - 1)];
    await route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r.body) });
  });
}

test('on-chain statement renders received and paid transfers with signs, and downloads the CSV', async ({ page }) => {
  await mockExplorer(page, [{ status: 200, body: { items: [
    item(TX_OUT, ME, BLUEJAY, '250000', '2026-11-07T09:30:00Z'),
    item(TX_IN, BLUEJAY, ME, '1500000', '2026-11-07T08:00:00Z'),
  ] } }]);
  await page.goto('/export/');
  const rows = page.getByTestId('statement-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Paid');
  await expect(rows.nth(0).getByTestId('statement-amount')).toHaveText('−0.25 USDT');
  await expect(rows.nth(1)).toContainText('Received');
  await expect(rows.nth(1)).toContainText('bluejay.taz0r.eth');
  await expect(rows.nth(1).getByTestId('statement-amount')).toHaveText('+1.50 USDT');
  await expect(rows.nth(1).locator('.in')).toHaveText('+1.50');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('statement-csv').click()]);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv).toBe(
    'Date,Counterparty,Direction,Amount (USDT),Tx hash\r\n' +
    `2026-11-07T09:30:00Z,${BLUEJAY},Paid,-0.25,${TX_OUT}\r\n` +
    `2026-11-07T08:00:00Z,${BLUEJAY},Received,1.50,${TX_IN}\r\n`);
});

test('statement failure shows a negative notice inside the card, and Retry recovers', async ({ page }) => {
  await mockExplorer(page, [{ status: 500, body: {} }, { status: 200, body: { items: [] } }]);
  await page.goto('/export/');
  await expect(page.getByTestId('statement-error')).toContainText('explorer HTTP 500');
  await expect(page.getByTestId('statement-csv')).toBeDisabled();
  await page.getByTestId('statement-retry').click();
  await expect(page.getByTestId('statement-empty')).toHaveText('No USDT transfers for this account yet.');
  await expect(page.getByTestId('empty')).toBeVisible();
});
