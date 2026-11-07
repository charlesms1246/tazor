import { test, expect } from '@playwright/test';

test('sidebar: selling first; B2B folded by default, remembered, and open on a B2B page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const main = page.locator('aside nav[aria-label="Main"] > a.nav-item');
  await expect(main).toHaveText(['Home', 'Start accepting USDT', 'Checkout', 'Reports', 'My payments (customer)', 'Autopilot']);
  await expect(page.locator('aside').getByTestId('nav-b2b')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('aside').getByTestId('nav-b2b-items')).toHaveCount(0);
  await expect(page.locator('aside .sidebar-foot a')).toHaveText(['Set up my passkey', 'Security & settings', 'Docs']);
  await page.locator('aside').getByTestId('nav-b2b').click();
  await expect(page.locator('aside').getByTestId('nav-b2b-items').locator('a')).toHaveText(['Invoices', 'Collect', 'Approvals', 'Payment runs', 'Company', 'Policies']);
  await page.reload();
  await expect(page.locator('aside').getByTestId('nav-b2b')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('aside').getByTestId('nav-b2b').click();
  await page.goto('/approvals/');
  await expect(page.locator('aside').getByTestId('nav-b2b')).toHaveAttribute('aria-expanded', 'true');
});

test('phone: the bottom nav is Home, Checkout, Reports, Start, More; Home never shows the zero address', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('nav.bottom-nav a')).toHaveText(['Home', 'Checkout', 'Reports', 'Start', 'More']);
  await expect(page.locator('main')).not.toContainText('0x0000…0000');
  await expect(page.getByTestId('lane-checkout')).toContainText('Checkout today');
  await expect(page.getByTestId('hero-start')).toHaveAttribute('href', '/start/');
});

test('docs open with the checkout line; B2B approvals is "also built"', async ({ page }) => {
  await page.goto('/docs/');
  await expect(page.getByTestId('docs-lead')).toHaveText('Tazor is USDT checkout for businesses on Whitechain: customers pay without gas, merchants refund in one click, and accountants get the export.');
  await expect(page.locator('article')).toContainText('Also built: B2B approvals');
  await page.goto('/docs/what-is-tazor/');
  await expect(page.getByTestId('what-lead')).toContainText('Tazor is USDT checkout for businesses on Whitechain');
});
