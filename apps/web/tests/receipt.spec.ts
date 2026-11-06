import { test, expect, type Page } from '@playwright/test';
import { toHex } from 'viem';
import { CHECKOUT, DEP_ORDER, DEPOSIT, ORDER, depositPaymentResult, paymentResult, rpcDepositLogs, rpcOrderLogs } from './checkout-fixtures.ts';
import { mockExplorer } from './explorer-mock.ts';

const ZEROS = `0x${'00'.repeat(192)}`;
const mockWhitechain = async (page: Page, o: { paid: boolean | 'deposit'; safe: number; finalized: number }) => {
  await page.route('https://rpc.testnet.whitechain.io/', async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    const ok = (result: unknown) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
    if (method === 'eth_call') {
      const to = String(params[0].to).toLowerCase();
      if (o.paid === 'deposit') return ok(to === DEPOSIT.toLowerCase() ? depositPaymentResult() : ZEROS);
      return ok(o.paid && to === CHECKOUT.toLowerCase() ? paymentResult() : ZEROS);
    }
    if (method === 'eth_getLogs') return ok(o.paid === 'deposit' ? rpcDepositLogs() : rpcOrderLogs());
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0];
      if (tag === 'safe') return ok({ number: toHex(o.safe), timestamp: toHex(1_794_003_000) });
      if (tag === 'finalized') return ok({ number: toHex(o.finalized), timestamp: toHex(1_794_004_000) });
      return ok({ number: tag, timestamp: toHex(1_794_002_400) });
    }
    return ok(null);
  });
};

test('/receipt/: a public receipt read from Whitechain: amount, refund, net, finality stages, QR and copy link', async ({ page }) => {
  await mockExplorer(page);
  await mockWhitechain(page, { paid: true, safe: 12_400_050, finalized: 12_300_000 });
  await page.goto(`/receipt/?order=${ORDER}&ref=BJ-77`);
  await expect(page.getByTestId('receipt-amount')).toHaveText('1.55 USDT');
  await expect(page.getByTestId('receipt-order')).toHaveText('BJ-77');
  await expect(page.getByTestId('receipt-status')).toHaveText('Partly refunded');
  await expect(page.getByTestId('receipt-refunded')).toHaveText('0.50 USDT in 1 refund');
  await expect(page.getByTestId('receipt-net')).toContainText('1.05 USDT');
  await expect(page.getByTestId('receipt-merchant')).toContainText('Bluejay Logistics');
  await expect(page.getByTestId('receipt-method')).toHaveText('Signed in wallet');
  await expect(page.getByTestId('receipt-refund-row')).toHaveCount(1);
  await expect(page.getByTestId('receipt-refund-row').locator('a')).toHaveAttribute('href', `https://explorer.testnet.whitechain.io/tx/0x${'bb'.repeat(32)}`);
  // posted to Ethereum (safe passed the block), not final yet (finalized behind it)
  await expect(page.getByTestId('receipt-stage-1')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('receipt-stage-2')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('receipt-stage-3')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('receipt-stage-3')).toContainText('usually about 30 min');
  // refund time comes from the refund block (RPC logs carry no time)
  await expect(page.getByTestId('receipt-refund-row').locator('td').first()).not.toHaveText('—');
  await expect(page.getByTestId('receipt-copy-link')).toHaveText('Copy link');
  await expect(page.getByTestId('receipt-qr')).toBeVisible();
  await expect(page.getByText('Read from Whitechain, not from Tazor').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText(ORDER);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('/receipt/: final once the finalized head passes the block; unpaid and malformed links explain themselves', async ({ page }) => {
  await mockExplorer(page);
  await mockWhitechain(page, { paid: true, safe: 12_500_000, finalized: 12_450_000 });
  await page.goto(`/receipt/?order=${ORDER}`);
  await expect(page.getByTestId('receipt-finality')).toHaveAttribute('data-stage', '3');
  await expect(page.getByTestId('receipt-stage-3')).toHaveAttribute('data-state', 'done');

  await page.goto(`/receipt/?order=${ORDER}&ref=NOT-THIS-ONE`);
  await expect(page.getByTestId('receipt-order')).not.toHaveText('NOT-THIS-ONE');
  await page.goto('/receipt/?order=0x1234');
  await expect(page.getByTestId('receipt-bad-id')).toContainText('This receipt link is incomplete');
});

test('/receipt/: an order with no payment yet', async ({ page }) => {
  await mockExplorer(page);
  await mockWhitechain(page, { paid: false, safe: 0, finalized: 0 });
  await page.goto(`/receipt/?order=${ORDER}`);
  await expect(page.getByTestId('receipt-unpaid')).toContainText('No payment for this order yet');
});

test('/receipt/: an order paid by a plain transfer is read from TazorDepositCheckout', async ({ page }) => {
  await mockExplorer(page);
  await mockWhitechain(page, { paid: 'deposit', safe: 12_400_050, finalized: 12_300_000 });
  await page.goto(`/receipt/?order=${DEP_ORDER}`);
  await expect(page.getByTestId('receipt-amount')).toHaveText('2.00 USDT');
  await expect(page.getByTestId('receipt-method')).toHaveText('Sent from an exchange or wallet');
  await expect(page.getByTestId('receipt-status')).toHaveText('Paid');
  await expect(page.getByTestId('receipt-net')).toContainText('2.00 USDT');
  await expect(page.locator('main')).toContainText('Refunds go to');
  await expect(page.getByTestId('receipt-refund-row')).toHaveCount(1);
  await expect(page.getByTestId('receipt-refund-row')).toContainText('Extra sent back');
  await expect(page.getByTestId('receipt-refund-row')).toContainText('0.25 USDT');
});
