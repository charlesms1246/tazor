import { test, expect, type Page } from '@playwright/test';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const M = '0x6B4E065d08D2cC7723635c6df0CC5268C706cD93';
const ID = `0x${'4c'.repeat(32)}`;
const TX = `0x${'7d'.repeat(32)}`;

/** Mocked relayer: the sandbox funds the demo wallet, /checkout/pay submits, /checkout/order reports the stage. */
async function relayer(page: Page, stage: { now: string }) {
  const paid: Record<string, unknown>[] = [];
  await page.route('https://rpc.testnet.whitechain.io/**', (r) => r.fulfill(json({ jsonrpc: '2.0', id: 1, result: null })));
  await page.route('http://relayer.test/sandbox/counterparty', (r) => r.fulfill(json({ ok: true, action: 'fund-demo-wallet', status: 'funded', tx: null, chain: 'whitechain', explorerUrl: null, detail: 'funded' })));
  await page.route('http://relayer.test/checkout/pay', async (r) => {
    paid.push(r.request().postDataJSON());
    await r.fulfill(json({ ok: true, id: ID, orderId: ID, txHash: TX, explorer: `https://explorer.testnet.whitechain.io/tx/${TX}`, stage: 'sequencer' }));
  });
  await page.route('http://relayer.test/checkout/order/**', (r) => r.fulfill(json({ id: ID, orderId: ID, status: 'paid', stage: stage.now })));
  return paid;
}

test('/paylink/: a small payment with the demo wallet, then "Ready to ship" and the receipt link', async ({ page }) => {
  const paid = await relayer(page, { now: 'sequencer' });
  await page.goto(`/paylink/?m=${M}&a=1.5&ref=${encodeURIComponent('INV-7 / table 3')}&n=${encodeURIComponent('Chai & Co')}`);
  await expect(page.getByTestId('pl-name')).toHaveText('Chai & Co');
  await expect(page.getByTestId('pl-amount')).toContainText('1.5');
  await expect(page.getByTestId('pl-ref')).toHaveText('INV-7 / table 3');
  await expect(page.getByTestId('pl-merchant')).toHaveText('0x6B4E…cD93');
  await expect(page.getByTestId('pl-merchant')).toHaveAttribute('data-value', M);
  await expect(page.getByTestId('paylink')).toContainText('Powered by Tazor · USDT on Whitechain');
  const button = page.getByTestId('pl-pay-button');
  await expect(button).toHaveAttribute('ship-above', '100');
  await expect(button).toHaveAttribute('mode', 'wallet');

  await page.getByTestId('tazor-demo-wallet').click();
  await expect(page.getByTestId('pl-paid')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('pl-paid')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('pl-paid')).toContainText('Ready to ship');
  await expect(page.getByTestId('pl-receipt')).toHaveAttribute('href', `/receipt/?order=${ID}&ref=${encodeURIComponent('INV-7 / table 3')}`);
  const body = paid[0] as { order: { merchant: string; amount: string } };
  expect([body.order.merchant, body.order.amount]).toEqual([M, '1500000']);
});

test('/paylink/: a payment at or above ship waits for Ethereum before "Ready to ship"', async ({ page }) => {
  const stage = { now: 'sequencer' };
  await relayer(page, stage);
  await page.goto(`/paylink/?m=${M}&a=150&ref=BIG-1&n=Bluejay&ship=100`);
  await page.getByTestId('tazor-demo-wallet').click();
  await expect(page.getByTestId('pl-paid')).toHaveAttribute('data-ready', 'false', { timeout: 15_000 });
  await expect(page.getByTestId('pl-paid')).toContainText('Wait');
  await expect(page.getByTestId('pl-ship')).toContainText('waiting for Whitechain to post it to Ethereum');
  stage.now = 'ethereum';
  await expect(page.getByTestId('pl-paid')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
});

test('/paylink/: friendly errors for a bad link; the testnet cap is 1000 USDT', async ({ page }) => {
  await page.goto('/paylink/?m=0x123&a=1&ref=x');
  await expect(page.getByTestId('pl-error')).toContainText('invalid business address');
  await page.goto(`/paylink/?m=${M}&a=1500&ref=x`);
  await expect(page.getByTestId('pl-error')).toContainText('at most 1000 USDT');
  await page.goto(`/paylink/?m=${M}&a=1`);
  await expect(page.getByTestId('pl-error')).toContainText('no order number');
  await expect(page.getByTestId('pl-pay-button')).toHaveCount(0);
});
