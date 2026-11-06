import { test, expect, type Page } from '@playwright/test';
import { decodeFunctionData, getAddress, isErc6492Signature, parseAbi, type Hex } from 'viem';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';
import { runDigest } from '../lib/runs.ts';
import type { Invoice } from '../lib/invoice.ts';
import { lc, routeRpc } from './rpc-mock.ts';

const PM = '0x0000000000000000000000000000000000007000';
const PM2 = '0x906620D82e2959351c81D731C67EA46DF71E36f3';
const FACTORY = '0x0000000000000000000000000000000000007001';
const APPROVER = '0x000000000000000000000000000000000000a001';
const BUYER = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const abi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function runDigest(InvoiceAuth[] auths) view returns (bytes32)',
  'function payRun(address account, InvoiceAuth[] auths, address[] approvers, bytes[] signatures)',
  'function configV2Of(address) view returns ((address,uint96,uint96,uint96,uint32,uint96,uint32,uint96,address[],uint32))',
  'function webAuthnVerifier() view returns (address)',
  'function predictAddress(bytes[] signers) view returns (address)',
]);
const inv = (id: string, amount: bigint): Invoice => ({
  id, supplierName: 'Bluejay', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c', payee: '0xc1dce946D192e344251972470237F1471C93876c',
  buyerAccount: BUYER, token: WHITECHAIN_SEPOLIA_USDT, amount, dueDate: 1798761600, lines: [{ description: id, quantity: 1n, unitPrice: amount }], memo: '',
});

async function setup(page: Page, deployed: boolean, posts: unknown[]) {
  await routeRpc(page, 'https://rpc.testnet.whitechain.io/', {
    [lc(PM)]: [{ abi, fn: 'runDigest', result: (a) => runDigest(a[0] as never, { chainId: 1874, verifyingContract: PM, version: '1' }) }],
    [lc(PM2)]: [{ abi, fn: 'configV2Of', result: () => ['0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0, 0n, 0, 0n, [], 0] }],
    [lc(FACTORY)]: [
      { abi, fn: 'webAuthnVerifier', result: () => '0x0000000000000000000000000000000000007002' },
      { abi, fn: 'predictAddress', result: () => APPROVER },
    ],
  }, deployed ? { [lc(APPROVER)]: '0x6001' } : {});
  await page.route('http://relayer.test/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (route.request().url().endsWith('/payrun')) {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ txHash: `0x${'cd'.repeat(32)}` }) });
    }
    return route.abort('connectionrefused');
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto('/onboard/');
  await page.getByTestId('create').click();
  await expect(page.getByTestId('approver-account')).toHaveAttribute('data-value', APPROVER);
}

async function fill(page: Page) {
  const links = [await encodeInvoiceLink(inv('RUN-1', 1_000_000n), 'http://localhost:4173'), await encodeInvoiceLink(inv('RUN-2', 2_500_000n), 'http://localhost:4173')];
  await page.goto('/runs/');
  await page.getByTestId('run-links').fill(links.join('\n'));
  await page.getByTestId('run-prepare').click();
  await expect(page.getByTestId('run-guard-ok')).toBeVisible();
  await expect(page.getByTestId('run-total')).toHaveText('3.50 USDT');
}

test('/runs/: one approval for two invoices, posted to /payrun; calldata uses payRun', async ({ page }) => {
  const posts: { account: string; auths: { nonce: string }[]; approvers: string[]; signatures: Hex[] }[] = [];
  await setup(page, true, posts);
  await fill(page);
  await page.getByTestId('run-approve').click();
  await page.getByTestId('run-pay').click();
  await expect(page.getByTestId('run-tx')).toHaveAttribute('data-tx', /^0xcdcd/);
  expect(posts).toHaveLength(1);
  expect(getAddress(posts[0].account)).toBe(BUYER);
  expect(posts[0].auths).toHaveLength(2);
  expect(posts[0].approvers).toEqual([APPROVER]);
  expect(isErc6492Signature(posts[0].signatures[0])).toBe(false);

  await page.getByTestId('run-calldata').click();
  const d = decodeFunctionData({ abi, data: (await page.getByTestId('run-calldata-out').textContent()) as Hex });
  expect(d.functionName).toBe('payRun');
  expect((d.args![1] as unknown[]).length).toBe(2);
});

test('/runs/: an undeployed approver sends an ERC-6492-wrapped approval; calldata carries the inner one', async ({ page }) => {
  const posts: { signatures: Hex[] }[] = [];
  await setup(page, false, posts);
  await fill(page);
  await page.getByTestId('run-approve').click();
  await page.getByTestId('run-pay').click();
  await expect(page.getByTestId('run-tx')).toBeVisible();
  expect(isErc6492Signature(posts[0].signatures[0])).toBe(true);
  await page.getByTestId('run-calldata').click();
  const d = decodeFunctionData({ abi, data: (await page.getByTestId('run-calldata-out').textContent()) as Hex });
  expect(isErc6492Signature((d.args![3] as Hex[])[0])).toBe(false);
});

test('/runs/: a tampered link refuses the whole run', async ({ page }) => {
  await setup(page, true, []);
  await page.goto('/runs/');
  const good = await encodeInvoiceLink(inv('RUN-1', 1_000_000n), 'http://localhost:4173');
  await page.getByTestId('run-links').fill(`${good}\n${good.slice(0, -4)}AAAA`);
  await page.getByTestId('run-prepare').click();
  await expect(page.getByTestId('run-bad')).toContainText('Link 2');
  await expect(page.getByTestId('run-guard-ok')).toHaveCount(0);
});
