import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT, buildInvoiceAuth, invoiceAuthDigest } from '../lib/invoice-auth.ts';
import { defaultAuthParams, encodePayOne } from '../lib/payment.ts';
import type { Invoice } from '../lib/invoice.ts';

const RPC = 'https://rpc.testnet.whitechain.io/';
const PAYMENT_MODULE = '0x0000000000000000000000000000000000007000';
const FACTORY = '0x0000000000000000000000000000000000007001';
const VERIFIER = '0x0000000000000000000000000000000000007002';
const APPROVER_ACCOUNT = '0x000000000000000000000000000000000000a001';
const SEL = {
  invoiceDigest: toFunctionSelector('invoiceDigest((bytes32,address,address,uint256,uint64,uint256))'),
  webAuthnVerifier: toFunctionSelector('webAuthnVerifier()'),
  predictAddress: toFunctionSelector('predictAddress(bytes[])'),
};

const invoice: Invoice = {
  id: 'INV-E2E-1', supplierName: 'Acme Steel', supplierAccount: '0x0000000000000000000000000000000000000002',
  payee: '0x0000000000000000000000000000000000000003', buyerAccount: '0x0000000000000000000000000000000000000001',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 1_250_500000n, dueDate: 1798761600,
  lines: [{ description: 'Rods', quantity: 100n, unitPrice: 12_000000n }, { description: 'Delivery', quantity: 1n, unitPrice: 50_500000n }],
  memo: 'PO 4471',
};
const { nonce, expiry } = defaultAuthParams(invoice);
const auth = buildInvoiceAuth(invoice, nonce, expiry);
const digest = invoiceAuthDigest(auth, { chainId: 1874, verifyingContract: PAYMENT_MODULE });

async function mockRpc(page: Page, invoiceDigest: Hex) {
  const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v]);
  await page.route(RPC, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    let result: Hex | null = null;
    if (method === 'eth_call') {
      const data: string = params[0].data;
      if (data.startsWith(SEL.invoiceDigest)) result = word('bytes32', invoiceDigest);
      else if (data.startsWith(SEL.webAuthnVerifier)) result = word('address', VERIFIER);
      else if (data.startsWith(SEL.predictAddress)) result = word('address', APPROVER_ACCOUNT);
    }
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(result ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error: { code: -32601, message: `unmocked ${method}` } }),
    });
  });
}

const link = async () => (await encodeInvoiceLink(invoice, 'http://localhost:4173')).replace('http://localhost:4173', '');

test('mismatching on-chain digest shows the refusal and keeps Approve disabled', async ({ page }) => {
  await mockRpc(page, `0x${'11'.repeat(32)}`);
  await page.goto(await link());
  await expect(page.getByTestId('guard-refused')).toContainText('Refusing to sign');
  await expect(page.getByTestId('guard-refused')).toContainText('does not match');
  await expect(page.getByTestId('approve')).toBeDisabled();
});

test('matching digest enables Approve; passkey approval feeds the payOne calldata', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await mockRpc(page, digest);

  await page.goto('/onboard/');
  await expect(page.getByTestId('wb-label')).toHaveText('Verified by WhiteBIT (simulated on testnet)');
  await page.getByTestId('create').click();
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER_ACCOUNT);
  await expect(page.getByTestId('signer')).toHaveText(new RegExp(`^${VERIFIER}[0-9a-f]{128}$`, 'i'));

  await page.goto(await link());
  await expect(page.getByTestId('guard-ok')).toContainText(digest);
  await expect(page.getByTestId('approve')).toBeEnabled();
  await page.getByTestId('approve').click();
  const approval = JSON.parse((await page.getByTestId('my-approval').textContent())!);
  expect(approval.approver.toLowerCase()).toBe(APPROVER_ACCOUNT);
  await expect(page.getByTestId('approval-count')).toHaveText('1');

  await page.getByTestId('calldata').click();
  await expect(page.getByTestId('calldata-out')).toHaveText(encodePayOne(auth, [approval]));
});

test('tampered link shows the invalid message', async ({ page }) => {
  await mockRpc(page, digest);
  const l = await link();
  await page.goto(l.replace(/\.([A-Za-z0-9_-])/, (_, c) => `.${c === 'A' ? 'B' : 'A'}`));
  await expect(page.getByTestId('invalid')).toHaveText('Invalid or tampered link');
});
