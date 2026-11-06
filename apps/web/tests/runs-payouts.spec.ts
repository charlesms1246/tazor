import { test, expect, type Page } from '@playwright/test';
import { BLUEJAY, CHECKOUT, DEPOSIT, depositExplorerItems, explorerItems } from './checkout-fixtures.ts';
import { mockExplorer } from './explorer-mock.ts';
import { decodeInvoiceLink } from '../lib/invoice-link.ts';

const SUP = '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6';
const json = (body: unknown) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function setup(page: Page, company: string, watch: string[] = []) {
  await page.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await mockExplorer(page, { [CHECKOUT]: explorerItems(), [DEPOSIT]: depositExplorerItems() });
  await page.route('https://rpc.testnet.whitechain.io/**', (r) => r.fulfill(json({ jsonrpc: '2.0', id: 1, result: null })));
  await page.addInitScript(([c, w]) => {
    localStorage.setItem('tazor.company.v1', c as string);
    localStorage.setItem('tazor.checkout.watch.v1', JSON.stringify(w));
  }, [company, watch] as const);
}

test('/runs/ Pay suppliers from sales: net checkout sales, a supplier payout becomes an invoice link in the run', async ({ page }) => {
  await setup(page, 'bluejay');
  await page.goto('/runs/');
  await page.getByTestId('po-open').click();
  // Bluejay's sales: 1.55 + 1.00 + 2.00 − 0.50 refunded
  await expect(page.getByTestId('po-net')).toHaveAttribute('data-net', '4050000', { timeout: 10_000 });
  await expect(page.getByTestId('po-topup')).toHaveCount(0, { timeout: 1000 });

  await page.getByTestId('po-add-to-run').click();
  await expect(page.getByTestId('po-error')).toContainText('Add at least one supplier');
  await page.getByTestId('po-address').fill(SUP);
  await page.getByTestId('po-name').fill('Milk Co');
  await page.getByTestId('po-amount').fill('1.25');
  await expect(page.getByTestId('po-plan')).toContainText('1.25 USDT');
  await expect(page.getByTestId('po-plan')).toContainText('4.05 USDT net sales');
  await page.getByTestId('po-add-to-run').click();
  await expect(page.getByTestId('po-added')).toContainText('Added 1 supplier payout (1.25 USDT)');
  const links = (await page.getByTestId('run-links').inputValue()).split('\n').filter(Boolean);
  expect(links).toHaveLength(1);
  const inv = await decodeInvoiceLink(links[0]);
  expect([inv.payee, inv.buyerAccount, inv.supplierName, inv.amount]).toEqual([SUP, BLUEJAY, 'Milk Co', 1_250_000n]);
});

test('/runs/: when sales arrive in another wallet, the panel says to top up the company account (with its address to copy)', async ({ page }) => {
  await setup(page, 'acme', [BLUEJAY]);
  await page.goto('/runs/');
  await page.getByTestId('po-open').click();
  const topup = page.getByTestId('po-topup');
  await expect(topup).toContainText('Sales arrive in', { timeout: 10_000 });
  await expect(topup).toContainText('payouts go from');
  await expect(topup).toContainText('Top up the company account from sales');
  await expect(topup.getByRole('button', { name: 'Copy company address' })).toBeVisible();
});
