import { test, expect } from '@playwright/test';

const CUSTOMER = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c';

test('/invoices/: create an invoice, and its link opens /pay/ with that invoice loaded', async ({ page }) => {
  // the Pay page reads the chain for its guards; nothing here needs real answers
  for (const url of ['https://rpc.testnet.whitechain.io/', 'https://ethereum-sepolia-rpc.publicnode.com/']) {
    await page.route(url, (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
  }

  await page.goto('/invoices/');
  await expect(page.getByTestId('inv-empty')).toBeVisible();
  await page.getByTestId('inv-customer').fill(CUSTOMER);
  await page.getByTestId('inv-payee').fill(PAYEE);
  await page.getByTestId('inv-supplier-name').fill('Bluejay Logistics');
  await page.getByTestId('inv-line-desc-0').fill('Freight');
  await page.getByTestId('inv-line-qty-0').fill('2');
  await page.getByTestId('inv-line-price-0').fill('0.6');
  await page.getByTestId('inv-add-line').click();
  await page.getByTestId('inv-line-desc-1').fill('Handling');
  await page.getByTestId('inv-line-price-1').fill('0.05');
  await expect(page.getByTestId('inv-total')).toHaveText('1.25 USDT');
  await page.getByTestId('inv-memo').fill('PO 77');

  await page.getByTestId('inv-create').click();
  const link = (await page.getByTestId('inv-link').textContent())!;
  expect(link).toMatch(/^http:\/\/localhost:4173\/pay\/#v1\./);
  await expect(page.getByTestId('inv-row')).toHaveCount(1);
  await expect(page.getByTestId('inv-status')).toHaveText('Sent');

  await page.goto(link.replace('http://localhost:4173', ''));
  await expect(page.locator('h1')).toContainText('Invoice INV-');
  await expect(page.getByTestId('amount')).toHaveText('1.25 USDT');
  await expect(page.getByText('Bluejay Logistics').first()).toBeVisible();
  await expect(page.getByTestId('invalid')).toHaveCount(0);

  // the list survives a reload on this device
  await page.goto('/invoices/');
  await expect(page.getByTestId('inv-row')).toHaveCount(1);
});

test('/invoices/: a bad form shows the problem inside the form', async ({ page }) => {
  await page.goto('/invoices/');
  await page.getByTestId('inv-customer').fill('0x1234');
  await page.getByTestId('inv-create').click();
  await expect(page.getByTestId('inv-error')).toContainText('Customer company account');
  await expect(page.getByTestId('inv-link')).toHaveCount(0);
});
