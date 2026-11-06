import { test, expect } from '@playwright/test';

test('Ctrl+K opens the palette, "pol" + Enter goes to Policies, Esc closes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('cmdk')).toHaveCount(0);
  await page.keyboard.press('Control+KeyK');
  const dialog = page.getByTestId('cmdk');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(page.getByTestId('cmdk-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press('Control+KeyK');
  await page.getByTestId('cmdk-input').fill('pol');
  await expect(page.getByTestId('cmdk-item').first()).toHaveAttribute('data-href', '/policies/');
  await expect(page.getByTestId('cmdk-item').first().locator('mark')).toHaveText('Pol');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/policies\/$/);
});

test('arrow keys move the highlight', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+KeyK');
  const items = page.getByTestId('cmdk-item');
  await expect(items.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toHaveAttribute('aria-selected', 'true');
});
