import { test, expect } from '@playwright/test';

test('a seeded tour shows step 1, Next advances, End closes', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('tour-seeded')) {
      localStorage.setItem('tazor.tour.v1', JSON.stringify({ step: 0, active: true }));
      sessionStorage.setItem('tour-seeded', '1');
    }
  });
  await page.goto('/');
  const card = page.getByTestId('tour-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 1 of 9');
  await expect(page.getByTestId('tour-back')).toBeDisabled();

  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 2 of 9');
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId('tour-back').click();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 1 of 9');

  await page.getByTestId('tour-next').click();
  await page.getByTestId('tour-next').click();
  await expect(page).toHaveURL(/\/invoices\/$/);
  await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 9');

  await page.getByTestId('tour-end').click();
  await expect(card).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tazor.tour.v1') ?? '{}'));
  expect(stored).toEqual({ step: 0, active: false });
  await page.reload();
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
});
