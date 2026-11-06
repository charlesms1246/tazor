import { test, expect } from '@playwright/test';
import { decodeFunctionData, erc20Abi, getAddress, keccak256, toBytes } from 'viem';
import { financingModuleAbi } from '../lib/abi/FinancingModule.ts';
import { APPROVER_ACCOUNT, FM, mockV2, onboard } from './v2-mock.ts';

const ACCOUNT = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const HOLDER = '0x03C291d446b870e0B8F128681937a9eCEDa97763';
const IH = keccak256(toBytes('financing e2e invoice'));

test('/financing/ commit calldata is right', async ({ page }) => {
  await mockV2(page, {});
  await onboard(page);
  await expect(page.getByTestId('approver-account')).toHaveAttribute('data-value', APPROVER_ACCOUNT);

  await page.goto('/financing/');
  await page.getByTestId('fin-hash').fill(IH);
  await page.getByTestId('fin-account').fill(ACCOUNT);
  await page.getByTestId('fin-holder').fill(HOLDER);
  await page.getByTestId('fin-amount').fill('2');
  await page.getByTestId('fin-due').fill('2030-01-01T00:00');
  await page.getByTestId('fin-prepare').click();
  const digest = (await page.getByTestId('fin-digest').textContent())!;
  await expect(page.getByTestId('fin-claim-id')).toHaveText(BigInt(digest).toString());
  await page.getByTestId('fin-approve').click();
  await page.getByTestId('fin-commit').click();

  const data = (await page.getByTestId('fin-commit-calldata-0').textContent()) as `0x${string}`;
  const { functionName, args } = decodeFunctionData({ abi: financingModuleAbi, data });
  expect(functionName).toBe('commit');
  const [f, approvers, sigs] = args as [{ invoiceHash: string; account: string; holder: string; amount: bigint; dueDate: bigint; nonce: bigint }, string[], string[]];
  expect(f.invoiceHash).toBe(IH);
  expect(getAddress(f.account)).toBe(ACCOUNT);
  expect(getAddress(f.holder)).toBe(HOLDER);
  expect(f.amount).toBe(2_000_000n);
  expect(f.dueDate).toBe(BigInt(Math.floor(new Date('2030-01-01T00:00').getTime() / 1000)));
  expect(approvers.map((a) => getAddress(a))).toEqual([APPROVER_ACCOUNT]);
  expect(sigs).toHaveLength(1);
  expect((await page.getByTestId('fin-commit-out').textContent())).toContain(FM);
});

test('/financing/ claim view, list, buy and settle calldata are right', async ({ page }) => {
  const id = 123456789n;
  await mockV2(page, { claim: [ACCOUNT, 1_700_000_000n, 2_000_000n], listing: 1_900_000n, owner: HOLDER });
  await page.goto('/financing/');
  await page.getByTestId('claim-id').fill(id.toString());
  await page.getByTestId('claim-view').click();
  await expect(page.getByTestId('claim-owner')).toHaveAttribute('data-value', HOLDER);
  await expect(page.getByTestId('claim-amount')).toHaveText('2.00 USDT');
  await expect(page.getByTestId('claim-price')).toHaveText('1.90 USDT');

  await page.getByTestId('list-price').fill('1.9');
  await page.getByTestId('claim-list').click();
  let d = decodeFunctionData({ abi: financingModuleAbi, data: (await page.getByTestId('claim-calldata-0').textContent()) as `0x${string}` });
  expect(d.functionName).toBe('list');
  expect(d.args).toEqual([id, 1_900_000n]);

  await page.getByTestId('claim-buy').click();
  const approve = decodeFunctionData({ abi: erc20Abi, data: (await page.getByTestId('claim-calldata-0').textContent()) as `0x${string}` });
  expect(approve.functionName).toBe('approve');
  expect(getAddress(approve.args![0] as string)).toBe(FM);
  expect(approve.args![1]).toBe(1_900_000n);
  d = decodeFunctionData({ abi: financingModuleAbi, data: (await page.getByTestId('claim-calldata-1').textContent()) as `0x${string}` });
  expect(d.functionName).toBe('buy');
  expect(d.args).toEqual([id]);

  await expect(page.getByTestId('claim-settle')).toBeEnabled(); // due date 1_700_000_000 is in the past
  await page.getByTestId('claim-settle').click();
  d = decodeFunctionData({ abi: financingModuleAbi, data: (await page.getByTestId('claim-calldata-0').textContent()) as `0x${string}` });
  expect(d.functionName).toBe('settle');
  expect(d.args).toEqual([id]);
});
