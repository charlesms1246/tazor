import { test, expect, type Page } from '@playwright/test';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';
import { invoiceHash, type Invoice } from '../lib/invoice.ts';

const invoice: Invoice = {
  id: 'INV-20261106-A1B2', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 2_500_000n, dueDate: 1798761600,
  lines: [{ description: 'Freight', quantity: 1n, unitPrice: 2_500_000n }], memo: 'PO 9',
};

const mockRpc = async (page: Page) => {
  for (const url of ['https://rpc.testnet.whitechain.io/', 'https://ethereum-sepolia-rpc.publicnode.com/']) {
    await page.route(url, (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
  }
};

test('/approvals/: opening a payment link adds a Needs-approval row with a timeline on /pay/', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/approvals/');
  await expect(page.getByTestId('approval-empty')).toContainText('Nothing is waiting for your approval');
  await expect(page.getByTestId('approvals-count-needs-approval')).toHaveText('0');

  const path = (await encodeInvoiceLink(invoice, 'http://x')).replace('http://x', '');
  await page.goto(path);
  await expect(page.locator('h1')).toContainText('Invoice INV-20261106-A1B2');
  const tl = page.getByTestId('pay-timeline');
  await expect(tl.locator('li[data-kind="created"]')).toContainText('INV-20261106-A1B2 created by Bluejay Logistics');
  await expect(tl.locator('li[data-kind="opened"]')).toContainText('INV-20261106-A1B2 opened by');
  await expect(tl.locator('li[data-tone="pending"]').first()).toHaveText('Waiting for approval');

  await page.goto('/approvals/');
  await expect(page.getByTestId('approvals-count-needs-approval')).toHaveText('1');
  const row = page.getByTestId('approval-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Invoice INV-20261106-A1B2');
  await expect(row).toContainText('Bluejay Logistics');
  await expect(row).toContainText('2.5 USDT');
  await expect(row.getByTestId('approval-status')).toHaveText('Needs approval');
  await expect(row.getByTestId('approval-review')).toHaveAttribute('href', `http://localhost:4173${path}`);

  // reopening the link does not duplicate the row
  await page.goto(path);
  await expect(page.locator('h1')).toContainText('Invoice INV-20261106-A1B2');
  await page.goto('/approvals/');
  await expect(page.getByTestId('approval-row')).toHaveCount(1);
});

test('/approvals/: a seeded paid item shows under Paid, not under Needs approval', async ({ page }) => {
  const item = {
    id: invoiceHash(invoice).toLowerCase(), kind: 'invoice', title: 'Invoice INV-PAID-1', counterparty: 'Bluejay Logistics',
    amount: '1200000', dueDate: 1798761600, href: '/pay/#v1.x.y', createdAt: Date.now(), status: 'paid', approvals: 2, required: 2,
  };
  await page.addInitScript((v) => localStorage.setItem('tazor.inbox.v1', v), JSON.stringify([item]));
  await page.goto('/approvals/');
  await expect(page.getByTestId('approval-empty')).toBeVisible();
  await expect(page.getByTestId('approvals-count-paid')).toHaveText('1');
  await page.getByTestId('approvals-tab-paid').click();
  const row = page.getByTestId('approval-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Invoice INV-PAID-1');
  await expect(row).toContainText('2 of 2 approvals');
  await expect(row.getByTestId('approval-status')).toHaveText('Paid');
});
