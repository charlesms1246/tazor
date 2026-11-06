import { test, expect } from '@playwright/test';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';
import { canonicalInvoiceJson, type Invoice } from '../lib/invoice.ts';

const invoice: Invoice = {
  id: 'INV-NOLINK-1', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 1_200_000n, dueDate: 1798761600,
  lines: [{ description: 'Freight', quantity: 1n, unitPrice: 1_200_000n }], memo: '',
};

test.beforeEach(async ({ page }) => {
  for (const url of ['https://rpc.testnet.whitechain.io/', 'https://ethereum-sepolia-rpc.publicnode.com/']) {
    await page.route(url, (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
  }
});

test('/pay/ without a link redirects to Approvals: opener, empty history and how it works; not the tampered-link state', async ({ page }) => {
  await page.goto('/pay/');
  await expect(page).toHaveURL(/\/approvals\/$/);
  await expect(page.locator('h1')).toHaveText('Approvals');
  await expect(page.getByTestId('invalid')).toHaveCount(0);
  await expect(page.getByTestId('paid-empty')).toBeVisible();
  await expect(page.getByText('How paying works')).toBeVisible();

  await page.getByTestId('open-link').fill('https://example.com/pay/#v1.abc.def');
  await page.getByTestId('open-link-go').click();
  await expect(page.getByTestId('open-link-error')).toContainText('not a payment link for this site');

  const link = await encodeInvoiceLink(invoice, 'http://localhost:4173');
  await page.getByTestId('open-link').fill(link);
  await page.getByTestId('open-link-go').click();
  await expect(page.locator('h1')).toHaveText('Invoice INV-NOLINK-1');
  await expect(page.getByTestId('amount')).toHaveText('1.2 USDT');
});

test('Approvals lists payments made from this device', async ({ page }) => {
  await page.goto('/approvals/');
  await page.evaluate((inv) => {
    localStorage.setItem('tazor.payments.v1', JSON.stringify([{ invoice: inv, txHash: `0x${'ab'.repeat(32)}`, blockTimestamp: 1793900000 }]));
  }, canonicalInvoiceJson(invoice));
  await page.reload();
  await expect(page.getByTestId('paid-row')).toHaveCount(1);
  await expect(page.getByTestId('paid-row')).toContainText('Bluejay Logistics');
  await expect(page.getByTestId('paid-row')).toContainText('INV-NOLINK-1');
  await expect(page.getByTestId('paid-row')).toContainText('1.2 USDT');
});

test('a real but tampered link still shows the invalid state', async ({ page }) => {
  const link = await encodeInvoiceLink(invoice, 'http://localhost:4173');
  await page.goto(`${link.replace('http://localhost:4173', '').slice(0, -4)}AAAA`);
  await expect(page.getByTestId('invalid')).toHaveText('Invalid or tampered link');
});
