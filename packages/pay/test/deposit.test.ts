import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult, keccak256, recoverTypedDataAddress, toFunctionSelector, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEPOSIT_CHECKOUT, addressQrSvg, depositAbi, depositOrder, depositRefundNonce, depositRefundTypedData, encodeDepositOrder, watchDeposit } from '../src/deposit.ts';

const ID = `0x${'ab'.repeat(32)}` as Hex;
// Read from TazorDepositCheckout 0xcb35…B3ab with eth_call on 6 Nov 2026.
const ONCHAIN_REFUND_NONCE_123_2 = '0x29c0726e002688d49db00a4e51a1f4856ea79cafc83e76862efda50fe78186f2';
const ORDER = { merchant: '0xc1dce946D192e344251972470237F1471C93876c', amount: 200_000n, ref: keccak256(toHex('BJ-3001')), deadline: 1_800_000_000n, refundTo: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967' } as const;
const ONCHAIN_ADDRESS = '0xAAAc1fec49461566A6120ff6C488A355A65Beb95';
const ONCHAIN_ID = '0x9b8e062d592f986d36ea7fc14883cf2ee195c4f256eaf08201784404280e7b0e';

test('deposit refund nonce equals the contract; the merchant refund signature recovers', async () => {
  assert.equal(depositRefundNonce(ID, 123n, 2), ONCHAIN_REFUND_NONCE_123_2);
  const m = privateKeyToAccount(`0x${'bb'.repeat(32)}`);
  const td = depositRefundTypedData(ID, m.address, 50_000n, 0);
  assert.equal((td.message as { to: string }).to, DEPOSIT_CHECKOUT);
  const sig = await m.signTypedData(td as never);
  assert.equal(await recoverTypedDataAddress(Object.assign({}, td, { signature: sig }) as never), m.address);
});

test('depositOrder reads the address and id from the contract views', async () => {
  const calls: string[] = [];
  const f = (async (_u: string, init?: RequestInit) => {
    const { params } = JSON.parse(String(init!.body));
    const sel = (params[0].data as string).slice(0, 10);
    calls.push(sel);
    const data = sel === toFunctionSelector('depositAddress((address,uint256,bytes32,uint64,address))')
      ? encodeFunctionResult({ abi: depositAbi, functionName: 'depositAddress', result: ONCHAIN_ADDRESS })
      : encodeFunctionResult({ abi: depositAbi, functionName: 'orderId', result: ONCHAIN_ID });
    return new Response(JSON.stringify({ result: data }));
  }) as typeof fetch;
  const d = await depositOrder({ ...ORDER, fetch: f });
  assert.equal(d.depositAddress, ONCHAIN_ADDRESS);
  assert.equal(d.orderId, ONCHAIN_ID);
  assert.equal(calls.length, 2);
  assert.equal(d.order.refundTo, ORDER.refundTo);
});

test('status route: base64url order, every change reported once, stops when final', async () => {
  const enc = encodeDepositOrder(ORDER);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(enc));
  const back = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(enc.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
  assert.deepEqual(back, { merchant: ORDER.merchant, amount: '200000', ref: ORDER.ref, deadline: '1800000000', refundTo: ORDER.refundTo });
  const seq = ['waiting', 'waiting', 'received', 'paid', 'ethereum', 'finalized'];
  const urls: string[] = [];
  const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ status: seq.shift() ?? 'finalized' })); }) as typeof fetch;
  const seen: string[] = [];
  await new Promise<void>((done) => watchDeposit(ORDER, (s) => { seen.push(s.status); if (s.status === 'finalized') done(); }, { fetch: f, intervalMs: 1 }));
  assert.deepEqual(seen, ['waiting', 'received', 'paid', 'ethereum', 'finalized']);
  assert.match(urls[0], /\/checkout\/deposit\/status\?order=[A-Za-z0-9_-]+$/);
});

test('the QR is an SVG of the address', async () => {
  const svg = await addressQrSvg(ONCHAIN_ADDRESS);
  assert.match(svg, /^<svg[\s\S]+<\/svg>$/);
});
