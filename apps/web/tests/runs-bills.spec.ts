import { test, expect } from '@playwright/test';
import { canonicalInvoiceJson, parseInvoice, type Invoice } from '../lib/invoice.ts';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { mockExplorer } from './explorer-mock.ts';

const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';
const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const bill = (id: string, amount: string, dueDate: number): Invoice => parseInvoice({
  id, supplierName: 'Bluejay Logistics', supplierAccount: BLUEJAY, payee: BLUEJAY, buyerAccount: ACME,
  token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', amount, dueDate, lines: [{ description: 'Freight', quantity: '1', unitPrice: amount }], memo: '',
});

test('/runs/: Acme picks unpaid bills from a checkbox table; the run total and the button follow the selection', async ({ page }) => {
  await mockExplorer(page);
  const bills = [bill('INV-20261101-AAAA', '1200000', 1577836800), bill('INV-20261102-BBBB', '300000', 4102444800)];
  const stored = await Promise.all(bills.map(async (b, i) => ({ invoice: canonicalInvoiceJson(b), link: await encodeInvoiceLink(b, 'http://localhost:4173'), createdAt: i + 1 })));
  await page.addInitScript((v) => localStorage.setItem('tazor.invoices.v1', v), JSON.stringify(stored));
  await page.goto('/runs/');

  const rows = page.getByTestId('run-bill-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Bluejay Logistics');
  await expect(page.getByTestId('run-approve-selected')).toHaveText('Pick bills to pay');
  await expect(page.getByTestId('run-approve-selected')).toBeDisabled();
  await expect(page.getByTestId('run-add-by-link')).not.toHaveAttribute('open', '');

  await page.getByTestId('run-select-all').check();
  await expect(page.getByTestId('run-bills-total')).toHaveText('1.50 USDT');
  await expect(page.getByTestId('run-approve-selected')).toHaveText('Approve 2 bills · 1.50 USDT with one passkey');

  await page.getByTestId('run-filter-due').selectOption('overdue');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('INV-20261101-AAAA');
  await rows.getByTestId('run-bill-check').uncheck();
  await expect(page.getByTestId('run-approve-selected')).toHaveText('Approve 1 bill · 0.30 USDT with one passkey');
});
