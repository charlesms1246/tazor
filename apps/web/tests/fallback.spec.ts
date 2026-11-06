import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, encodeFunctionResult, toFunctionSelector, type Hex } from 'viem';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT, buildInvoiceAuth, invoiceAuthDigest } from '../lib/invoice-auth.ts';
import { defaultAuthParams } from '../lib/payment.ts';
import { encodeForward, invoicePaidTopics } from '../lib/ensgate.ts';
import { mandateModuleAbi } from '../lib/abi/MandateModule.ts';
import type { Invoice } from '../lib/invoice.ts';
import { unwrap6492 } from '../lib/erc6492.ts';

const WC_RPC = 'https://rpc.testnet.whitechain.io/';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com/';
const PAYMENT_MODULE = '0x0000000000000000000000000000000000007000';
const APPROVER_ACCOUNT = '0x000000000000000000000000000000000000a001';
const L2_TX = `0x${'cd'.repeat(32)}`;
const SEL = {
  invoiceDigest: toFunctionSelector('invoiceDigest((bytes32,address,address,uint256,uint64,uint256))'),
  webAuthnVerifier: toFunctionSelector('webAuthnVerifier()'),
  predictAddress: toFunctionSelector('predictAddress(bytes[])'),
  mandateOf: toFunctionSelector('mandateOf(bytes32)'),
  available: toFunctionSelector('available(bytes32)'),
};

const invoice: Invoice = {
  id: 'INV-L1-1', supplierName: 'Bluejay', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 1_200_000n, dueDate: 1798761600,
  lines: [{ description: 'Freight', quantity: 1n, unitPrice: 1_200_000n }], memo: '',
};
const { nonce, expiry } = defaultAuthParams(invoice);
const auth = buildInvoiceAuth(invoice, nonce, expiry);
const digest = invoiceAuthDigest(auth, { chainId: 1874, verifyingContract: PAYMENT_MODULE });
const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v]);

async function mockChains(page: Page, opts: { delivered: () => boolean }) {
  const json = (id: number, result: unknown) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  await page.route(WC_RPC, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    if (method === 'eth_blockNumber') return route.fulfill(json(id, '0x100'));
    if (method === 'eth_getCode') return route.fulfill(json(id, '0x6001')); // the approver account is deployed
    if (method === 'eth_getLogs') {
      const logs = opts.delivered() ? [{ topics: invoicePaidTopics(auth.account, auth.nonce), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [invoice.payee, invoice.amount, true]), transactionHash: L2_TX, blockNumber: '0x101' }] : [];
      return route.fulfill(json(id, logs));
    }
    const data: string = params?.[0]?.data ?? '';
    if (data.startsWith(SEL.invoiceDigest)) return route.fulfill(json(id, word('bytes32', digest)));
    if (data.startsWith(SEL.webAuthnVerifier)) return route.fulfill(json(id, word('address', '0x0000000000000000000000000000000000007002')));
    if (data.startsWith(SEL.predictAddress)) return route.fulfill(json(id, word('address', APPROVER_ACCOUNT)));
    if (data.startsWith(SEL.mandateOf)) {
      return route.fulfill(json(id, encodeFunctionResult({ abi: mandateModuleAbi, functionName: 'mandateOf', result: {
        account: '0x18d15B034C645dbbFCb9c68238A14D059f632513', period: 2592000n, cancelled: false, payee: '0xc1dce946D192e344251972470237F1471C93876c',
        start: 1794000000n, cap: 2000000n, expiry: 1801719053n, spent: 1500000n, periodIndex: 0,
      } })));
    }
    if (data.startsWith(SEL.available)) return route.fulfill(json(id, word('uint256', 500000n)));
    return route.fulfill(json(id, '0x'));
  });
  await page.route(SEPOLIA_RPC, async (route) => {
    const { id, method } = route.request().postDataJSON();
    if (method === 'eth_estimateGas') return route.fulfill(json(id, '0x75c00'));
    if (method === 'eth_gasPrice') return route.fulfill(json(id, '0x3b9aca00'));
    return route.fulfill(json(id, null));
  });
  await page.route('http://relayer.test/**', (route) => route.abort('connectionrefused'));
}

test('relayer down: Send via Ethereum builds forward calldata, estimates the fee and sees delivery', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  let delivered = false;
  await mockChains(page, { delivered: () => delivered });

  await page.goto('/onboard/');
  await page.getByTestId('create').click();
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER_ACCOUNT);

  await page.goto((await encodeInvoiceLink(invoice, 'http://x')).replace('http://x', ''));
  await page.getByTestId('approve').click();
  const approval = JSON.parse((await page.getByTestId('my-approval').textContent())!);

  await page.getByTestId('pay').click();
  await expect(page.getByTestId('error')).toContainText('Relayer unreachable');

  await page.getByTestId('prepare-l1').click();
  await expect(page.getByTestId('l1-fee')).toHaveText('Estimated fee: 0.000482304 ETH (482304 gas)');
  await expect(page.getByTestId('l1-data')).toHaveText(encodeForward('acme', auth, [{ ...approval, signature: unwrap6492(approval.signature).inner }]) as string);

  await page.getByTestId('watch-l1').click();
  await expect(page.getByTestId('l1-status')).toContainText('Waiting');
  delivered = true;
  await expect(page.getByTestId('l1-status')).toContainText(`Delivered on Whitechain`, { timeout: 10_000 });
  await expect(page.getByTestId('l1-status').locator('a')).toHaveAttribute('href', `https://explorer.testnet.whitechain.io/tx/${L2_TX}`);
});

test('mandates: tracking the live mandate shows terms and what is available now', async ({ page }) => {
  await mockChains(page, { delivered: () => false });
  await page.goto('/mandates/');
  await page.getByTestId('track-id').fill('0x08d47f1cfdc3adfe04d41ce6135822149f4440ebf88fdc6b34612c9049c2e574');
  await page.getByTestId('track').click();
  await expect(page.getByTestId('available')).toHaveText('0.5 USDT');
  await expect(page.getByTestId('mandate-row')).toContainText('2 USDT / 30 days');
});

test('home page shows the bank vs Tazor timing card with proof links', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('timings');
  await expect(card).toContainText('3.6 s');
  await expect(card).toContainText('69 s via Ethereum');
  await expect(card).toContainText('3.06 s');
  await expect(card.getByText('measured').first()).toBeVisible();
  await expect(card).toContainText('100 s');
  await expect(card.locator('a[href*="0x027e1cfd"]')).toHaveCount(1);
  await expect(page.getByTestId('host')).toHaveText('localhost:4173');
  await expect(page.getByTestId('build')).toHaveText('unversioned');
});
