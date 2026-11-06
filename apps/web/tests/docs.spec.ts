import { test, expect } from '@playwright/test';
import { ALL_DOC_PAGES, DOC_GROUPS, docHref } from '../app/docs/content.ts';

test('/docs/ lists every group and every page', async ({ page }) => {
  await page.goto('/docs/');
  await expect(page.locator('.docs-article h1')).toHaveText('Tazor docs');
  const groups = page.getByTestId('docs-group');
  await expect(groups).toHaveCount(DOC_GROUPS.length);
  for (const g of DOC_GROUPS) {
    await expect(page.locator('.docs-article h2', { hasText: g.title })).toBeVisible();
    for (const p of g.pages) await expect(page.locator(`.docs-article a[href="${docHref(p.slug)}"]`)).toBeVisible();
  }
});

test('every docs page loads with its h1, lead and an active nav item', async ({ page }) => {
  for (const p of ALL_DOC_PAGES) {
    await page.goto(docHref(p.slug));
    await expect(page.locator('.docs-article h1'), p.slug).toHaveText(p.title);
    await expect(page.locator('.docs-lead')).toHaveText(p.summary);
    await expect(page.locator(`.docs-nav a[aria-current="page"]`)).toHaveText(p.title);
  }
});

test('timings page links the 0x027e1cfd revocation proof', async ({ page }) => {
  await page.goto('/docs/timings/');
  await expect(page.getByTestId('docs-timings').locator('a[href*="0x027e1cfd"]')).toHaveCount(1);
});

test('on a phone the topic select replaces the nav and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/docs/');
  await expect(page.getByTestId('docs-nav')).toBeHidden();
  await page.getByTestId('docs-topic').selectOption('/docs/mandates/');
  await expect(page).toHaveURL(/\/docs\/mandates\/$/);
  await expect(page.locator('.docs-article h1')).toHaveText('Mandates (direct debits)');
});

test('/developers/ redirects to the passkey check', async ({ page }) => {
  await page.goto('/developers/');
  await expect(page).toHaveURL(/\/docs\/passkey-check\/$/);
  await expect(page.getByTestId('create')).toBeVisible();
});
