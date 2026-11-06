import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { canonicalInvoiceJson, type Invoice } from '../lib/invoice.ts';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';

const invoice: Invoice = {
  id: 'INV-7', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 1_200_000n, dueDate: 1798761600,
  lines: [{ description: 'Freight', quantity: 1n, unitPrice: 1_200_000n }], memo: 'PO 12',
};
const TX = '0xbceeaa443a3e17a19037a677a459a88dcd11a7e17b01ebd431118c997ce84f21';

test('export page downloads the four files from payments stored on this device', async ({ page }) => {
  await page.addInitScript(([v]) => localStorage.setItem('tazor.payments.v1', v), [JSON.stringify([{ invoice: canonicalInvoiceJson(invoice), txHash: TX, blockTimestamp: 1794000000 }])]);
  await page.goto('/export/');
  await expect(page.getByText('INV-7')).toBeVisible();
  const expectations: [string, RegExp][] = [
    ['tally', /^Date,Voucher Type,.*\r\n06\/11\/2026,Payment,INV-7,/s],
    ['xero', /^\*Date,\*Amount,.*\r\n06\/11\/2026,-1\.20,/s],
    ['quickbooks', /^Date,Description,Amount\r\n11\/06\/2026,.*,-1\.20\r\n$/s],
    ['camt', /<Ntry><Amt Ccy="USDT">1\.200000<\/Amt><CdtDbtInd>DBIT<\/CdtDbtInd>.*<EndToEndId>INV-7<\/EndToEndId>/s],
  ];
  for (const [id, re] of expectations) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(id).click()]);
    expect(readFileSync((await download.path())!, 'utf8')).toMatch(re);
  }
});

test('export page with nothing stored says so', async ({ page }) => {
  await page.goto('/export/');
  await expect(page.getByTestId('empty')).toBeVisible();
});
