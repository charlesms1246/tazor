import { test, expect } from '@playwright/test';

const M = '0xc1dce946D192e344251972470237F1471C93876c';

test('/start/: a business sets up: name, wallet, threshold → dashboard, reports, payment link with QR, 15-line snippet', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/start/');
  await expect(page.getByTestId('start-diagram')).toContainText('Tazor serves you');
  await expect(page.getByTestId('start-diagram')).toContainText('They pay without gas');
  await expect(page.getByTestId('start-waiting')).toBeVisible();

  await page.getByTestId('start-name').fill('Chai Point');
  await page.getByTestId('start-wallet').fill('0x123');
  await expect(page.getByTestId('start-wallet-error')).toBeVisible();
  await page.getByTestId('start-wallet').fill(M.toLowerCase());
  await page.getByTestId('start-ship').fill('250');

  await expect(page.getByTestId('start-dashboard')).toHaveAttribute('href', `/checkout/?merchant=${M}`);
  await expect(page.getByTestId('start-reports')).toHaveAttribute('href', `/export/?merchant=${M}`);

  await page.getByTestId('start-amount').fill('12.50');
  await page.getByTestId('start-ref').fill('CP-0042');
  const link = await page.getByTestId('start-copy-link').getAttribute('data-link');
  const u = new URL(link!);
  expect(u.pathname).toBe('/paylink/');
  expect(Object.fromEntries(u.searchParams)).toEqual({ m: M, a: '12.50', ref: 'CP-0042', n: 'Chai Point', ship: '250' });
  await expect(page.getByTestId('start-qr')).toBeVisible();
  await page.getByTestId('start-copy-link').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Payment link copied' })).toBeVisible();

  const snippet = await page.getByTestId('start-snippet').textContent();
  expect(snippet!.split('\n')).toHaveLength(15);
  for (const a of [`merchant="${M}"`, 'amount="12.50"', 'order-ref="CP-0042"', 'ship-above="250"', 'demo-wallet="true"']) expect(snippet).toContain(a);
  await page.getByTestId('start-copy-snippet').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(snippet);

  await page.getByTestId('start-amount').fill('5000');
  await expect(page.getByTestId('start-link-error')).toContainText('at most 1000 USDT');
  await expect(page.getByTestId('start-copy-link')).toHaveCount(0);

  await expect(page.getByTestId('start-test-secret')).toContainText('whsec_tazor_demo_test');
  await page.getByTestId('start-webhook').fill('https://chai.example/tazor');
  const entry = JSON.parse((await page.getByTestId('start-webhook-config').textContent())!);
  expect(entry[M].url).toBe('https://chai.example/tazor');
  expect(entry[M].secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  expect(entry[M].shipAbove).toBe('250');

  // saved in this browser
  await page.reload();
  await expect(page.getByTestId('start-name')).toHaveValue('Chai Point');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('/start/: "Create a demo wallet" makes a testnet wallet in this browser and uses it', async ({ page }) => {
  await page.goto('/start/');
  await page.getByTestId('start-demo-wallet').click();
  const a = await page.getByTestId('start-wallet').inputValue();
  expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await expect(page.getByTestId('start-demo-note')).toContainText('testnet only');
  await page.reload();
  await expect(page.getByTestId('start-demo-wallet')).toHaveText('Use my demo wallet');
  await expect(page.getByTestId('start-wallet')).toHaveValue(a);
});

test('/start/: in the nav first under Receive, and linked from the Home story', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('story-start')).toHaveAttribute('href', '/start/');
  await expect(page.locator('a[href="/start/"]').filter({ hasText: 'Start accepting USDT' }).first()).toBeAttached();
});
