import { test, expect } from '@playwright/test';
import { decodeAbiParameters, decodeFunctionData, getAddress } from 'viem';
import { paymentModuleV2Abi } from '../lib/abi/PaymentModuleV2.ts';
import { APPROVER_ACCOUNT, PM2, VERIFIER, mockV2, onboard } from './v2-mock.ts';

const ACCOUNT = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c';
const EXIT = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';

const config = {
  registry: '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', twoApproverThreshold: 5_000_000n, perPaymentLimit: 8_000_000n,
  monthlyLimit: 20_000_000n, payeeDelay: 120, freshThreshold: 3_000_000n, maxCacheAge: 300, agentMonthlyCap: 3_000_000n,
  exitAccounts: [EXIT], exitDelay: 180,
};

test('/policies/ renders the v2 config and add-payee produces the right calldata', async ({ page }) => {
  await mockV2(page, { config, window: [12_000_000n, 2_000_000n], pendingExit: [EXIT, BigInt(Math.floor(Date.now() / 1000) + 90)] });
  await onboard(page);
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER_ACCOUNT);

  await page.goto('/policies/');
  await expect(page.getByTestId('cfg-per-payment')).toHaveText('8 USDT');
  await expect(page.getByTestId('cfg-monthly')).toContainText('20 USDT');
  await expect(page.getByTestId('win-company')).toHaveText('12 USDT');
  await expect(page.getByTestId('cfg-payee-delay')).toHaveText('120 s');
  await expect(page.getByTestId('cfg-fresh')).toContainText('3 USDT (roles cached within 300 L1 blocks)');
  await expect(page.getByTestId('cfg-agent')).toContainText('3 USDT');
  await expect(page.getByTestId('win-agent')).toHaveText('2 USDT');
  await expect(page.getByTestId('cfg-exits')).toContainText(EXIT);
  await expect(page.getByTestId('exit-status')).toContainText('Exit pending to');
  await expect(page.getByTestId('exit-countdown')).toBeVisible();
  await expect(page.getByTestId('execute-exit')).toBeDisabled();

  await page.getByTestId('payee').fill(PAYEE);
  const before = Math.floor(Date.now() / 1000);
  await page.getByTestId('add-payee').click();
  const data = (await page.getByTestId('add-payee-calldata').textContent()) as `0x${string}`;
  const { functionName, args } = decodeFunctionData({ abi: paymentModuleV2Abi, data });
  expect(functionName).toBe('addPayee');
  const [account, payee, admin, deadline, sig] = args as [string, string, string, bigint, `0x${string}`];
  expect(getAddress(account)).toBe(ACCOUNT);
  expect(getAddress(payee)).toBe(PAYEE);
  expect(getAddress(admin)).toBe(APPROVER_ACCOUNT);
  expect(Number(deadline)).toBeGreaterThanOrEqual(before + 3600);
  expect(Number(deadline)).toBeLessThan(before + 3700);
  // ApproverAccount approval: abi.encode(bytes[] [verifier ++ x ++ y], bytes[] [WebAuthn signature])
  const [signers, sigs] = decodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], sig);
  expect(signers).toHaveLength(1);
  expect(signers[0].slice(0, 42).toLowerCase()).toBe(VERIFIER.toLowerCase());
  expect(signers[0].length).toBe(2 + 84 * 2);
  expect(sigs[0].length).toBeGreaterThan(2 + 6 * 64);
  await expect(page.getByTestId('add-payee-digest')).toHaveText(/^0x[0-9a-f]{64}$/);
  expect((await page.getByTestId('add-payee-out').textContent())).toContain(PM2);
});

test('/policies/ refuses a non-v2 account', async ({ page }) => {
  await mockV2(page, { config: { ...config, registry: '0x0000000000000000000000000000000000000000', exitAccounts: [] } });
  await page.goto('/policies/');
  await expect(page.getByTestId('load-error')).toContainText('not a v2 company');
});
