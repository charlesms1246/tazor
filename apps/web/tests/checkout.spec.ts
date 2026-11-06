import { test, expect, type Page } from '@playwright/test';
import { CHECKOUT, DEP_ORDER, DEPOSIT, ORDER, PAYER, depositExplorerItems, explorerItems } from './checkout-fixtures.ts';
import { mockExplorer } from './explorer-mock.ts';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

const setup = async (page: Page, company = 'bluejay') => {
  await mockExplorer(page, { [CHECKOUT]: explorerItems(), [DEPOSIT]: depositExplorerItems() });
  await page.route('https://rpc.testnet.whitechain.io/', (route) => route.fulfill(json({ jsonrpc: '2.0', id: 1, result: null })));
  await page.route('http://relayer.test/webhooks/recent**', (route) => route.fulfill(json({
    merchant: '0xc1dce946D192e344251972470237F1471C93876c', storage: 'memory', note: 'Deliveries are kept per relayer instance.',
    items: [{ id: 'evt_1', type: 'order.paid', created: 1_794_002_400, txHash: `0x${'aa'.repeat(32)}`, status: 'delivered', attempts: 1, httpStatus: 200, data: {} }],
  })));
  await page.route('http://relayer.test/webhooks/test', (route) => route.fulfill(json({ error: 'no endpoint configured for this merchant' }, 404)));
  await page.route('http://relayer.test/x402/settlements**', (route) => route.fulfill(json({
    payTo: '0xc1dce946D192e344251972470237F1471C93876c', storage: 'memory',
    items: [{ id: 'x_1', created: 1_794_002_400, txHash: `0x${'ee'.repeat(32)}`, payer: PAYER, amount: '10000', resource: 'https://api.example.com/report', network: 'whitechain-sepolia' }],
  })));
  await page.addInitScript((c) => { if (!localStorage.getItem('tazor.company.v1')) localStorage.setItem('tazor.company.v1', c); }, company);
};

test('/checkout/: orders for the selected merchant with refunds and a receipt link; subscriptions show what is due', async ({ page }) => {
  await setup(page);
  await page.goto('/checkout/?tab=orders');
  await expect(page.getByTestId('co-scope')).toContainText('Bluejay Logistics');
  const all = page.getByTestId('co-order-row');
  await expect(all).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('co-tab-orders')).toHaveText('Orders2');
  await expect(page.getByTestId('co-tab-orders').locator('.tab-count')).toHaveText('2');
  await expect(page.getByTestId('co-demo-toggle')).toHaveAttribute('aria-pressed', 'true');
  const dep = all.filter({ has: page.locator(`a[href="/receipt/?order=${DEP_ORDER.toLowerCase()}"]`) });
  await expect(dep.getByTestId('co-order-method')).toContainText('Sent from an exchange or wallet');
  await expect(dep).toContainText('2.00 USDT');
  await expect(dep.getByTestId('co-order-returned')).toHaveText('0.25 USDT extra sent back');
  await expect(dep.getByTestId('co-order-status')).toHaveText('Paid');
  const rows = all.filter({ has: page.locator(`a[href="/receipt/?order=${ORDER.toLowerCase()}"]`) });
  await expect(rows.getByTestId('co-order-method')).toHaveText('Signed in wallet');
  await expect(rows).toContainText('1.55 USDT');
  await expect(rows).toContainText('0.50 USDT');
  await expect(rows.getByTestId('co-order-status')).toHaveText('Partly refunded');
  await expect(rows.getByTestId('co-receipt')).toHaveAttribute('href', `/receipt/?order=${ORDER.toLowerCase()}`);
  await rows.getByTestId('co-refund').click();
  await expect(page.getByTestId('co-refund-amount')).toHaveValue('1.05');
  await expect(page.locator('main')).toContainText('Face ID, fingerprint');

  await page.getByTestId('co-tab-subscriptions').click();
  const sub = page.getByTestId('co-sub-row');
  await expect(sub).toHaveCount(1);
  await expect(sub).toContainText('1.00 USDT');
  await expect(sub).toContainText('every 1 min');
  await expect(sub).toContainText('1 of 3');
  await expect(sub.getByTestId('co-sub-next')).toHaveText('Due now');
  await expect(sub.getByTestId('co-charge')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('/checkout/: webhooks list recent deliveries and the signature scheme; agents list x402 payments', async ({ page }) => {
  await setup(page);
  await page.goto('/checkout/');
  await page.getByTestId('co-tab-webhooks').click();
  await expect(page.getByTestId('co-hook-row')).toContainText('order.paid');
  await expect(page.getByTestId('co-hook-row')).toContainText('Delivered');
  await expect(page.getByTestId('co-hook-verify')).toContainText('createHmac');
  await page.getByTestId('co-hook-test').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'No webhook endpoint is configured' })).toBeVisible();

  await page.getByTestId('co-tab-agents').click();
  const a = page.getByTestId('co-agent-row');
  await expect(a).toContainText('https://api.example.com/report');
  await expect(a).toContainText('0.01 USDT');
  await expect(a.locator('a').last()).toHaveAttribute('href', `https://explorer.testnet.whitechain.io/tx/0x${'ee'.repeat(32)}`);
});

test('/checkout/: a company with no orders still opens on the live demo merchants, labelled; the chip turns them off', async ({ page }) => {
  await setup(page, 'acme');
  await page.goto('/checkout/?tab=orders');
  const rows = page.getByTestId('co-order-row');
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await expect(rows.first().getByTestId('co-order-merchant')).toContainText('to Bluejay');
  await expect(page.getByTestId('co-scope')).toContainText('plus the live demo merchants');
  await page.getByTestId('co-demo-toggle').click();
  await expect(page.getByTestId('co-orders-empty')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('co-demo-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('/checkout/: ?merchant= and &tab= open a tab for a linked merchant', async ({ page }) => {
  await setup(page, 'acme');
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/x402/settlements')) asked.push(r.url()); });
  await page.goto(`/checkout/?merchant=${PAYER}&tab=agents`);
  await expect(page.getByTestId('co-tab-agents')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('co-agent-row')).toHaveCount(1);
  expect(asked.some((u) => u.toLowerCase().includes(`payto=${PAYER.toLowerCase()}`))).toBe(true);
  expect(asked.some((u) => u.toLowerCase().includes('payto=0xbc9a2fc48f141162eaff4c0767dac50362f96bc6'))).toBe(true);
  await page.getByTestId('co-tab-webhooks').click();
  await expect(page).toHaveURL(/tab=webhooks/);
  await expect(page.getByTestId('co-hook-row')).toHaveCount(1);
});

test('/checkout/ Overview (default tab): net sales, payments, refund rate, repeat customers, 14-day chart, paid-with mix, top customers; no sideways scroll on a phone', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await setup(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/checkout/');
  await expect(page.getByTestId('co-tab-overview')).toHaveAttribute('aria-selected', 'true');
  // Bluejay: 1.55 (wallet, 0.50 refunded) + 1.00 (subscription charge) + 2.00 (exchange transfer)
  await expect(page.getByTestId('ov-net')).toContainText('4.05', { timeout: 10_000 });
  await expect(page.getByTestId('ov-payments')).toHaveText('3');
  await expect(page.getByTestId('ov-refund-rate')).toHaveText('11%');
  await expect(page.getByTestId('ov-repeat')).toHaveText('1');
  await expect(page.getByTestId('ov-day')).toHaveCount(14);
  await expect(page.locator('[data-testid="ov-day"][data-day="2026-11-06"]')).toHaveAttribute('data-net', '3050000');
  await expect(page.locator('[data-testid="ov-day"][data-day="2026-11-01"]')).toHaveAttribute('data-net', '1000000');
  await expect(page.getByTestId('ov-mix-wallet')).toContainText('1.55 USDT');
  await expect(page.getByTestId('ov-mix-transfer')).toContainText('2.00 USDT');
  await expect(page.getByTestId('ov-mix-subscription')).toContainText('1.00 USDT');
  await expect(page.getByTestId('ov-top-row').first()).toContainText('2.05 USDT');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByTestId('co-tab-orders').click();
  await expect(page.getByTestId('co-order-row')).toHaveCount(2);
});
