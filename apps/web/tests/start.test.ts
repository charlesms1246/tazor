import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import {
  amountError, buttonSnippet, createDemoWallet, demoWalletSigner, loadDemoWallet, refError, shipError, webhookConfig, webhookError,
} from '../lib/start.ts';
import { refundTypedData } from '../lib/checkout.ts';

const M = '0xc1dce946d192e344251972470237f1471c93876c';

test('the snippet is 15 lines, checksummed, with the merchant, amount, order, ship-above and demo-wallet attributes', () => {
  const s = buttonSnippet({ origin: 'https://tazor-app.vercel.app', merchant: M, shipAbove: '250', amount: '12.50', ref: 'ORDER-7', demoWallet: true });
  const lines = s.split('\n');
  assert.equal(lines.length, 15);
  assert.ok(s.includes('<script src="https://tazor-app.vercel.app/tazor-pay.js"></script>'));
  for (const a of ['merchant="0xc1dce946D192e344251972470237F1471C93876c"', 'amount="12.50"', 'order-ref="ORDER-7"', 'ship-above="250"', 'demo-wallet="true"', 'mode="wallet"']) assert.ok(s.includes(a), a);
});

test('inputs are checked in plain English', () => {
  assert.equal(amountError('10'), null);
  assert.equal(amountError('0.000001'), null);
  assert.match(amountError('0') ?? '', /amount like/);
  assert.match(amountError('1001') ?? '', /at most 1000 USDT/);
  assert.match(amountError('1.1234567') ?? '', /amount like/);
  assert.equal(shipError('100'), null);
  assert.match(refError('') ?? '', /order number/);
  assert.match(refError('x'.repeat(65)) ?? '', /64/);
  assert.equal(webhookError(''), null);
  assert.equal(webhookError('https://shop.example/hook'), null);
  assert.match(webhookError('http://shop.example/hook') ?? '', /https/);
  assert.match(webhookError('shop') ?? '', /full address/);
  assert.deepEqual(JSON.parse(webhookConfig(M, 'https://a.example/h', 'whsec_x', '100')), { '0xc1dce946D192e344251972470237F1471C93876c': { url: 'https://a.example/h', secret: 'whsec_x', shipAbove: '100' } });
});

test('the demo wallet is created once, kept in this browser, and signs refunds only for its own address', async () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  assert.equal(loadDemoWallet(), null);
  const a = createDemoWallet();
  assert.equal(createDemoWallet(), a, 'the same wallet on the second call');
  assert.equal(loadDemoWallet(), a);
  assert.equal(demoWalletSigner(M), null, 'not for another merchant');
  const s = demoWalletSigner(a.toLowerCase())!;
  const td = refundTypedData(`0x${'11'.repeat(32)}`, a, 20_000n, 0, { checkout: '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670', validAfter: 0n, validBefore: 9_999_999_999n });
  const sig = await s.signTypedData(td);
  assert.equal(await recoverTypedDataAddress({ ...(td as object), signature: sig } as never), a);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
