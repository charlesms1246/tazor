import { mockExplorer } from './explorer-mock.ts';
import { test, expect, type Page } from '@playwright/test';

const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';

const mockRpc = async (page: Page) => {
  for (const url of ['https://rpc.testnet.whitechain.io/', 'https://ethereum-sepolia-rpc.publicnode.com/']) {
    await page.route(url, (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
  }
};

const usdt = async (page: Page, testId: string) => Number((await page.getByTestId('inv-preview').getByTestId(testId).textContent())!.replace(/,/g, ''));

test('/invoices/: "Fill with sample data" as Acme switches the supplier to Bluejay, and the link opens /pay/ with the guided steps', async ({ page }) => {
  await mockExplorer(page);
  await mockRpc(page);
  await page.goto('/invoices/');
  await page.getByTestId('inv-fill-sample').click();

  await expect(page.getByTestId('inv-sample-hint')).toContainText('the supplier was switched');
  await expect(page.getByTestId('inv-supplier-name')).toHaveValue('Bluejay Logistics');
  await expect(page.getByTestId('inv-payee')).toHaveValue(BLUEJAY);
  await expect(page.getByTestId('inv-supplier-account')).toHaveValue(BLUEJAY);
  await expect(page.getByTestId('inv-customer')).toHaveValue(ACME);
  await expect(page.getByTestId('inv-billto')).toHaveValue(ACME);
  await expect(page.getByTestId('inv-tax-rate')).toHaveValue('18');
  await expect(page.getByTestId('inv-tax-label')).toHaveValue('GST');
  await expect(page.getByTestId('inv-memo')).toHaveValue(/^PO-\d{4}-\d{4}$/);
  await expect(page.getByTestId('inv-line-desc-1')).not.toHaveValue('');
  await expect(page.getByTestId('inv-supplier-warning')).toHaveCount(0);

  const subtotal = await usdt(page, 'paper-subtotal');
  expect(subtotal).toBeGreaterThanOrEqual(0.5);
  expect(subtotal).toBeLessThanOrEqual(1.5);
  expect(await usdt(page, 'paper-tax')).toBeCloseTo(subtotal * 0.18, 5);

  await page.getByTestId('inv-create').click();
  await expect(page.getByTestId('toast').filter({ hasText: /Payment link for INV-\d{8}-[0-9A-F]{4} created/ })).toBeVisible();
  const link = (await page.getByTestId('inv-link').getAttribute('data-link'))!;
  await page.goto(link.replace('http://localhost:4173', ''));
  await expect(page.locator('h1')).toContainText('Invoice INV-');
  await expect(page.getByTestId('pay-steps')).toBeVisible();
  await expect(page.getByTestId('pay-step-1')).toContainText('Check supplier');
  await expect(page.getByTestId('pay-step-2')).toContainText('Approve with passkey');
  await expect(page.getByTestId('pay-step-4')).toHaveAttribute('data-state', 'todo');
  await expect(page.getByText('Bluejay Logistics').first()).toBeVisible();
});

test('/invoices/: as Bluejay the sample bills Acme from the selected company', async ({ page }) => {
  await mockExplorer(page);
  await page.addInitScript(() => localStorage.setItem('tazor.company.v1', 'bluejay'));
  await page.goto('/invoices/');
  await page.getByTestId('inv-fill-sample').click();
  await expect(page.getByTestId('inv-sample-hint')).toHaveText(/^Sample invoice from Bluejay Logistics to Acme Industries\./);
  await expect(page.getByTestId('inv-payee')).toHaveValue(BLUEJAY);
  await expect(page.getByTestId('inv-billto')).toHaveValue(ACME);
  await expect(page.getByTestId('inv-error')).toHaveCount(0);
});
