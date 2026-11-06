import { test, expect } from '@playwright/test';
import { decodeFunctionData, getAddress } from 'viem';
import { paymentModuleV2Abi } from '../lib/abi/PaymentModuleV2.ts';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT, buildInvoiceAuth } from '../lib/invoice-auth.ts';
import { defaultAuthParams } from '../lib/payment.ts';
import { invoiceAuthDigestV2 } from '../lib/policies.ts';
import type { Invoice } from '../lib/invoice.ts';
import { APPROVER_ACCOUNT, PM2, mockV2, onboard } from './v2-mock.ts';

const ACCOUNT = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const invoice: Invoice = {
  id: 'INV-V2-1', supplierName: 'Bluejay', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: ACCOUNT, token: WHITECHAIN_SEPOLIA_USDT,
  amount: 1_000_000n, dueDate: 1798761600, lines: [{ description: 'Service', quantity: 1n, unitPrice: 1_000_000n }], memo: '',
};

test('/pay/ for a v2 company signs for PaymentModuleV2 (domain v2) and builds payAsAgent calldata', async ({ page }) => {
  await mockV2(page, { config: {
    registry: '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', twoApproverThreshold: 5_000_000n, perPaymentLimit: 8_000_000n,
    monthlyLimit: 20_000_000n, payeeDelay: 120, freshThreshold: 3_000_000n, maxCacheAge: 300, agentMonthlyCap: 3_000_000n,
    exitAccounts: [], exitDelay: 0,
  } });
  await onboard(page);
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER_ACCOUNT);

  const { nonce, expiry } = defaultAuthParams(invoice);
  const auth = buildInvoiceAuth(invoice, nonce, expiry);
  await page.goto((await encodeInvoiceLink(invoice, 'http://x')).replace('http://x', ''));
  await expect(page.getByTestId('v2-account')).toContainText(PM2);
  await expect(page.getByTestId('guard-ok')).toContainText(invoiceAuthDigestV2(auth, { chainId: 1874, verifyingContract: PM2 }));

  await page.getByTestId('approve').click();
  await page.getByTestId('pay-as-agent').click();
  const { functionName, args } = decodeFunctionData({ abi: paymentModuleV2Abi, data: (await page.getByTestId('calldata-out').textContent()) as `0x${string}` });
  expect(functionName).toBe('payAsAgent');
  const [account, a, agent] = args as unknown as [string, { nonce: bigint; amount: bigint }, string, string];
  expect(getAddress(account)).toBe(ACCOUNT);
  expect(a.nonce).toBe(nonce);
  expect(a.amount).toBe(1_000_000n);
  expect(getAddress(agent)).toBe(APPROVER_ACCOUNT);

  await page.getByTestId('calldata').click();
  expect(decodeFunctionData({ abi: paymentModuleV2Abi, data: (await page.getByTestId('calldata-out').textContent()) as `0x${string}` }).functionName).toBe('payOne');
  await page.getByTestId('pay').click();
  await expect(page.getByTestId('error')).toContainText('v1 payments only');
});
