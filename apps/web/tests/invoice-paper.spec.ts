import { mockExplorer } from './explorer-mock.ts';
import { test, expect, type Page } from '@playwright/test';

const CUSTOMER = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c';

const fillParties = async (page: Page) => {
  await page.getByTestId('inv-customer').fill(CUSTOMER);
  await page.getByTestId('inv-payee').fill(PAYEE);
  await page.getByTestId('inv-supplier-name').fill('Bluejay Logistics');
};

test.beforeEach(async ({ page }) => {
  await mockExplorer(page);
  for (const url of ['https://rpc.testnet.whitechain.io/', 'https://ethereum-sepolia-rpc.publicnode.com/']) {
    await page.route(url, (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
  }
});

test('/invoices/: the paper updates live while typing', async ({ page }) => {
  await page.goto('/invoices/');
  const paper = page.getByTestId('inv-preview').getByTestId('invoice-paper');
  await expect(paper.getByTestId('paper-stamp')).toHaveText('DRAFT');
  await expect(paper.getByTestId('paper-number')).toHaveText('Assigned on create');
  await expect(paper.getByTestId('paper-qr-placeholder')).toHaveText('QR appears when you create the link');
  await expect(paper.getByTestId('paper-total')).toHaveText('0.00');

  await page.getByTestId('inv-line-desc-0').fill('Freight Mumbai to Pune');
  await expect(paper).toContainText('Freight Mumbai to Pune');
  await page.getByTestId('inv-line-price-0').fill('12.5');
  await expect(paper.getByTestId('paper-total')).toHaveText('12.50');
  await page.getByTestId('inv-line-qty-0').fill('3');
  await expect(paper.getByTestId('paper-total')).toHaveText('37.50');
});

test('/invoices/: 18% tax on 100 shows 18.00 and a total of 118.00, and the link carries it as a line', async ({ page }) => {
  await page.goto('/invoices/');
  await fillParties(page);
  await page.getByTestId('inv-line-desc-0').fill('Freight');
  await page.getByTestId('inv-line-price-0').fill('100');
  await page.getByTestId('inv-tax-rate').fill('18');
  const paper = page.getByTestId('inv-preview').getByTestId('invoice-paper');
  await expect(paper.getByTestId('paper-subtotal')).toHaveText('100.00');
  await expect(paper.getByTestId('paper-tax')).toHaveText('18.00');
  await expect(paper).toContainText('GST 18%');
  await expect(paper.getByTestId('paper-total')).toHaveText('118.00');
  await expect(page.getByTestId('inv-total')).toHaveText('118 USDT');

  await page.getByTestId('inv-create').click();
  const link = (await page.getByTestId('inv-link').textContent())!;
  await page.goto(link.replace('http://localhost:4173', ''));
  await expect(page.getByTestId('amount')).toHaveText('118 USDT');
  await expect(page.getByTestId('paper-tax')).toHaveText('18.00');
  await expect(page.getByTestId('paper-total')).toHaveText('118.00');
  await expect(page.getByTestId('paper-stamp')).toHaveText('SENT');
});

test('/invoices/: after create the QR is drawn and the stamp says SENT; a row reopens it read-only', async ({ page }) => {
  await page.goto('/invoices/');
  await fillParties(page);
  await page.getByTestId('inv-line-desc-0').fill('Freight');
  await page.getByTestId('inv-line-price-0').fill('1.2');
  await page.getByTestId('inv-create').click();

  const paper = page.getByTestId('inv-preview').getByTestId('invoice-paper');
  await expect(paper.getByTestId('paper-stamp')).toHaveText('SENT');
  await expect(paper.locator('svg[data-testid="paper-qr"]')).toBeVisible();
  await expect(paper.getByTestId('paper-qr-placeholder')).toHaveCount(0);
  await expect(paper.getByTestId('paper-number')).toHaveText(/^INV-\d{8}-[0-9A-F]{4}$/);
  // the paper shows the QR and a Copy payment link button (not the long link); the button carries the same link
  const created = (await page.getByTestId('inv-link').textContent()) ?? '';
  await expect(paper.getByTestId('paper-copy-link')).toHaveAttribute('data-link', created);
  await expect(paper.getByTestId('paper-open-link')).toHaveAttribute('href', created);
  await expect(paper).not.toContainText('/pay/#v1.');
  await expect(page.getByTestId('inv-pdf')).toBeVisible();

  await page.reload();
  await expect(paper.getByTestId('paper-stamp')).toHaveText('DRAFT');
  await page.getByTestId('inv-row').first().click();
  const drawer = page.getByTestId('inv-drawer');
  await expect(drawer.getByTestId('paper-stamp')).toHaveText('SENT');
  await expect(drawer.locator('svg[data-testid="paper-qr"]')).toBeVisible();
  await page.getByTestId('inv-view-close').click();
  await expect(drawer).toHaveCount(0);
  await expect(paper.getByTestId('paper-stamp')).toHaveText('DRAFT');
});
