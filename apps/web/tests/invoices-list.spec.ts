import { test, expect, type Page } from '@playwright/test';

const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c';

const create = async (page: Page, desc: string, price: string, due: string) => {
  await page.getByTestId('inv-customer').fill(ACME);
  await page.getByTestId('inv-payee').fill(PAYEE);
  await page.getByTestId('inv-supplier-name').fill('Bluejay Logistics');
  await page.getByTestId('inv-line-desc-0').fill(desc);
  await page.getByTestId('inv-line-price-0').fill(price);
  await page.getByTestId('inv-due').fill(due);
  await page.getByTestId('inv-create').click();
  await expect(page.getByTestId('inv-link')).toBeVisible();
};

test('/invoices/: tabs count and total, search filters, and the drawer shows the invoice timeline', async ({ page }) => {
  await page.goto('/invoices/');
  await create(page, 'Freight', '10', '2099-01-31');
  await create(page, 'Storage', '2.5', '2020-01-31');

  await expect(page.getByTestId('inv-tab-count-all')).toHaveText('2');
  await expect(page.getByTestId('inv-tab-total-all')).toHaveText('12.5 USDT');
  await expect(page.getByTestId('inv-tab-count-sent')).toHaveText('1');
  await expect(page.getByTestId('inv-tab-count-overdue')).toHaveText('1');
  await expect(page.getByTestId('inv-tab-total-overdue')).toHaveText('2.5 USDT');
  await expect(page.getByTestId('inv-tab-count-paid')).toHaveText('0');

  await page.getByTestId('inv-tab-overdue').click();
  await expect(page.getByTestId('inv-row')).toHaveCount(1);
  await expect(page.getByTestId('inv-status')).toHaveText('Overdue');
  await page.getByTestId('inv-tab-paid').click();
  await expect(page.getByTestId('inv-filter-empty')).toBeVisible();

  await page.getByTestId('inv-tab-all').click();
  await page.getByTestId('inv-search').fill('2.5');
  await expect(page.getByTestId('inv-row')).toHaveCount(1);
  await page.getByTestId('inv-search').fill('acme');
  await expect(page.getByTestId('inv-row')).toHaveCount(2);
  await page.getByTestId('inv-search').fill('no such invoice');
  await expect(page.getByTestId('inv-filter-empty')).toBeVisible();
  await page.getByTestId('inv-search').fill('');

  await page.getByTestId('inv-row').first().click();
  const drawer = page.getByTestId('inv-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('paper-stamp')).toHaveText('SENT');
  const tl = drawer.getByTestId('inv-timeline');
  await expect(tl.locator('li[data-kind="created"]')).toContainText('created by Bluejay Logistics');
  await expect(tl.locator('li[data-kind="sent"]')).toContainText('sent to Acme');
  await expect(tl.locator('li[data-tone="pending"]').first()).toHaveText('Customer opens the link');
  await expect(drawer.getByTestId('inv-view-pdf')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('/invoices/: the selected company prefills the supplier, and Bill to offers the other company', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tazor.company.v1', 'bluejay'));
  await page.goto('/invoices/');
  await expect(page.getByTestId('inv-supplier-name')).toHaveValue('Bluejay Logistics');
  await expect(page.getByTestId('inv-payee')).toHaveValue(PAYEE);
  await expect(page.getByTestId('inv-billto')).toHaveValue(ACME);
  await expect(page.getByTestId('inv-customer')).toHaveValue(ACME);
  await page.getByTestId('inv-billto').selectOption('');
  await expect(page.getByTestId('inv-customer')).toHaveValue('');
});
