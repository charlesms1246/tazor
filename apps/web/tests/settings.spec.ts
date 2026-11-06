import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT, buildInvoiceAuth, invoiceAuthDigest } from '../lib/invoice-auth.ts';
import { defaultAuthParams } from '../lib/payment.ts';
import type { Invoice } from '../lib/invoice.ts';

const WC_RPC = 'https://rpc.testnet.whitechain.io/';
const PAYMENT_MODULE = '0x0000000000000000000000000000000000007000';
const APPROVER_ACCOUNT = '0x000000000000000000000000000000000000a001';
const CUSTOM = 'https://my-relayer.example';
const DEFAULT = 'http://relayer.test';
const TX = `0x${'ab'.repeat(32)}`;
const SEL = {
  invoiceDigest: toFunctionSelector('invoiceDigest((bytes32,address,address,uint256,uint64,uint256))'),
  webAuthnVerifier: toFunctionSelector('webAuthnVerifier()'),
  predictAddress: toFunctionSelector('predictAddress(bytes[])'),
};
const invoice: Invoice = {
  id: 'INV-SET-1', supplierName: 'Bluejay', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 1_000_000n, dueDate: 1798761600,
  lines: [{ description: 'Service', quantity: 1n, unitPrice: 1_000_000n }], memo: '',
};
const { nonce, expiry } = defaultAuthParams(invoice);
const digest = invoiceAuthDigest(buildInvoiceAuth(invoice, nonce, expiry), { chainId: 1874, verifyingContract: PAYMENT_MODULE });
const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v]);

async function mock(page: Page, posts: string[]) {
  const json = (id: number, result: unknown) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  await page.route(WC_RPC, async (route) => {
    const { id, params } = route.request().postDataJSON();
    const data: string = params?.[0]?.data ?? '';
    if (data.startsWith(SEL.invoiceDigest)) return route.fulfill(json(id, word('bytes32', digest)));
    if (data.startsWith(SEL.webAuthnVerifier)) return route.fulfill(json(id, word('address', '0x0000000000000000000000000000000000007002')));
    if (data.startsWith(SEL.predictAddress)) return route.fulfill(json(id, word('address', APPROVER_ACCOUNT)));
    return route.fulfill(json(id, null));
  });
  const relayer = (base: string) => page.route(`${base}/**`, async (route) => {
    const url = route.request().url();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.endsWith('/health')) return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ ok: true, relayer: '0x000000000000000000000000000000000000beef', paymentModule: PAYMENT_MODULE }) });
    if (url.endsWith('/approver')) return route.abort('connectionrefused');
    posts.push(url);
    return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ txHash: TX }) });
  });
  await relayer(CUSTOM);
  await relayer(DEFAULT);
}

async function payOnce(page: Page) {
  await page.goto((await encodeInvoiceLink(invoice, 'http://x')).replace('http://x', ''));
  await expect(page.getByTestId('guard-ok')).toBeVisible();
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('my-approval')).toBeVisible();
  await page.getByTestId('pay').click();
  await expect(page.getByTestId('tx')).toContainText(TX);
}

test('/security/ relayer URL: saved override is used by /pay/, clearing reverts to the default', async ({ page }) => {
  const posts: string[] = [];
  await mock(page, posts);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto('/onboard/');
  await page.getByTestId('create').click();
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER_ACCOUNT);

  await page.goto('/security/');
  await expect(page.getByTestId('relayer-current')).toContainText(`${DEFAULT} (default for this build)`);
  await expect(page.getByTestId('addresses')).toContainText('PaymentModuleV2');
  await page.getByTestId('relayer-url').fill('http://evil.example');
  await page.getByTestId('relayer-save').click();
  await expect(page.getByTestId('relayer-note')).toContainText('Not saved');
  await page.getByTestId('relayer-url').fill(`${CUSTOM}/`);
  await page.getByTestId('relayer-save').click();
  await expect(page.getByTestId('relayer-current')).toContainText(`${CUSTOM} (set on this device)`);
  await page.getByTestId('relayer-test').click();
  await expect(page.getByTestId('relayer-health')).toContainText('Relayer OK: sender 0x000000000000000000000000000000000000beef');

  await payOnce(page);
  expect(posts).toEqual([`${CUSTOM}/pay`]);

  await page.goto('/security/');
  await page.getByTestId('relayer-clear').click();
  await expect(page.getByTestId('relayer-current')).toContainText(`${DEFAULT} (default for this build)`);
  await payOnce(page);
  expect(posts).toEqual([`${CUSTOM}/pay`, `${DEFAULT}/pay`]);
});

test('home page and footer link the v2 pages and settings', async ({ page }) => {
  await page.goto('/');
  for (const href of ['/policies/', '/financing/', '/settings/']) {
    await expect(page.locator(`main a[href="${href}"]`).first()).toBeVisible();
    await expect(page.getByTestId('footer-links').locator(`a[href="${href}"]`)).toBeVisible();
  }
});

test('/settings/ redirects to Security & settings, keeping the relayer controls', async ({ page }) => {
  await page.goto('/settings/');
  await expect(page).toHaveURL(/\/security\/$/);
  await expect(page.locator('h1')).toHaveText('Security & settings');
  await expect(page.getByTestId('relayer-url')).toBeVisible();
  await expect(page.getByTestId('addresses')).toContainText('PaymentModuleV2');
  await expect(page.getByTestId('freeze-account')).toHaveCount(1);
});
