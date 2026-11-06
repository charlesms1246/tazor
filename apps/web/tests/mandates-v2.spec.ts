import { test, expect } from '@playwright/test';
import { mockV2, onboard } from './v2-mock.ts';

const ACCOUNT = '0xE6eE20A68d9053d8Bc3F8bb99Dc255c1de5b7116';
const PAYEE = '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6';
const config = {
  registry: '0xaa0F1d232e0464dCCBeB2D6470387e507e818840', twoApproverThreshold: 500_000n, perPaymentLimit: 1_000_000n,
  monthlyLimit: 10_000_000n, payeeDelay: 60, freshThreshold: 0n, maxCacheAge: 0, agentMonthlyCap: 1_000_000n,
  exitAccounts: [], exitDelay: 120,
};

test('/mandates/: a v2 company signs the MandateModuleV2 digest (domain "2"); the page shows meaning, raw values only under Technical details', async ({ page }) => {
  const mm2Calls: string[] = [];
  await mockV2(page, { config, mm2Calls });
  await onboard(page);
  await page.goto('/mandates/');
  await page.getByTestId('m-account').fill(ACCOUNT);
  await page.getByTestId('m-payee').fill(PAYEE);
  await page.getByTestId('m-cap').fill('0.30');
  await page.getByTestId('m-expiry').fill(new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10));
  await page.getByTestId('m-prepare').click();

  const digest = page.getByTestId('m-digest');
  await expect(digest).toContainText('The contract agrees: Mandate to');
  await expect(digest).toContainText('up to 0.30 USDT / 30 days · #');
  await expect(digest).toHaveAttribute('data-value', /^0x[0-9a-f]{64}$/);
  await expect(digest).not.toContainText(/0x[0-9a-fA-F]{40}/);
  expect(mm2Calls).toContain('mandateDigest');
  await expect(page.getByTestId('m-error')).toHaveCount(0);
  await expect(page.locator('details.tech-details summary')).toHaveText('Technical details · For developers');
  await expect(page.locator('details.tech-details')).not.toHaveAttribute('open', '');
});
