import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { toHex } from 'viem';
import { CHECKOUT, DEPOSIT, ORDER, explorerItems, depositExplorerItems } from './checkout-fixtures.ts';
import { mockExplorer } from './explorer-mock.ts';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

const setup = async (page: Page) => {
  await mockExplorer(page, { [CHECKOUT]: explorerItems(), [DEPOSIT]: depositExplorerItems() });
  await page.route('https://rpc.testnet.whitechain.io/', (route) => {
    const { id, method } = route.request().postDataJSON();
    if (method === 'eth_getBlockByNumber') return route.fulfill(json({ jsonrpc: '2.0', id, result: { number: toHex(12_500_000), timestamp: toHex(1_794_004_000) } }));
    return route.fulfill(json({ jsonrpc: '2.0', id, result: null }));
  });
  await page.route('http://relayer.test/**', (route) => route.fulfill(json({ items: [] })));
  await page.addInitScript(() => { if (!localStorage.getItem('tazor.company.v1')) localStorage.setItem('tazor.company.v1', 'bluejay'); });
};

const csvOf = async (page: Page, testid: string) => {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId(testid).click()]);
  return readFileSync((await d.path())!, 'utf8');
};

test('/export/: Checkout sales as accountant rows (payment, refund, transfer) with totals; the CSV matches the Checkout page', async ({ page }) => {
  await setup(page);
  await page.goto(`/export/?order=${ORDER}`);
  const ledger = page.getByTestId('ck-ledger');
  await expect(ledger.locator('tbody tr')).toHaveCount(3, { timeout: 10_000 });
  await expect(page.getByTestId('ck-focus-payment')).toContainText('1.55 USDT');
  await expect(page.getByTestId('ck-focus-refund')).toContainText('0.50 USDT');
  await expect(page.getByTestId('ck-focus-refund')).toContainText('−0.50 USDT');
  await expect(page.getByTestId('ck-row')).toContainText('Sent from an exchange or wallet');
  await expect(page.getByTestId('ck-totals')).toContainText('3.55 USDT');
  await expect(page.getByTestId('ck-totals')).toContainText('3.05 USDT');
  await expect(page.locator('main')).not.toContainText(ORDER);
  const fromReports = await csvOf(page, 'ck-csv');
  const lines = fromReports.trim().split('\n');
  expect(lines[0]).toBe('Date (UTC),Type,Customer,Merchant,Order,Paid with,Gross USDT,Refund USDT,Net USDT,Transaction');
  expect(lines).toHaveLength(4);
  expect(lines.find((l) => l.includes(',Refund,'))).toContain(',0.00,0.50,-0.50,');
  expect(lines.find((l) => l.includes(',Payment,') && l.includes(ORDER.toLowerCase()))).toContain(',1.55,0.00,1.55,');

  await page.goto('/checkout/');
  await expect(page.getByTestId('co-order-row')).toHaveCount(2, { timeout: 10_000 });
  expect(await csvOf(page, 'co-csv')).toBe(fromReports);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('/checkout/ and /receipt/: small payments are ready to ship at once', async ({ page }) => {
  await setup(page);
  await page.goto('/checkout/');
  const ship = page.getByTestId('co-order-ship');
  await expect(ship.first()).toHaveText('Ready to ship', { timeout: 10_000 });
  await expect(ship.first()).toHaveAttribute('title', 'Ready to ship: under 100 USDT, confirmation on Whitechain is enough');
});

test('/autopilot/: the 2-minute story comes first, the full tour under More', async ({ page }) => {
  await setup(page);
  await page.goto('/autopilot/');
  await expect(page.getByTestId('autopilot-featured')).toContainText('The story (2 min)');
  await expect(page.getByTestId('autopilot-story-short-step')).toHaveText([/A customer pays/, /The merchant refunds part of it/, /The accountant gets the export/]);
  await expect(page.getByTestId('autopilot-start-story')).toHaveText('Play the story');
  const featuredTop = (await page.getByTestId('autopilot-featured').boundingBox())!.y;
  const moreTop = (await page.getByTestId('autopilot-more').boundingBox())!.y;
  expect(featuredTop).toBeLessThan(moreTop);
  await expect(page.getByTestId('autopilot-story')).not.toContainText('Financing');
});

test('Home: the three-step story strip, and nothing links to financing', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.getByTestId('story-pay')).toHaveAttribute('href', 'https://bluejay-shop.vercel.app');
  await expect(page.getByTestId('story-pay')).toHaveAttribute('target', '_blank');
  await expect(page.getByTestId('story-refund')).toHaveAttribute('href', '/checkout/');
  await expect(page.getByTestId('story-export')).toHaveAttribute('href', '/export/#checkout');
  await expect(page.getByTestId('story-also')).toContainText('AI agents (x402)');
  await expect(page.locator('a[href*="financing"]')).toHaveCount(0);
});
