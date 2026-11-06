import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainSeparator, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHECKOUT, USDT_DOMAIN, accountSigner, cancelSubscription, cancelTypedData, chargeSubscription, orderId, orderRef, payNonce, payOrder,
  payTypedData, refundNonce, refundOrder, refundTypedData, subId, subNonce, subscribe, subscribeTypedData, toEip712Json, walletSigner, watchOrder,
  type Order, type Plan, type TypedData,
} from '../src/checkout.ts';

// Computed by the deployed TazorCheckout 0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670 (eth_call of its views) on 6 Nov 2026.
const ORDERS: { order: Order; orderId: Hex; payNonce: Hex; refundNonce_123_2: Hex }[] = [
  { order: { merchant: '0xc1dce946D192e344251972470237F1471C93876c', amount: 1_550_000n, ref: '0xca21501d00bcc785732b16a9cbf2e2b7e53f8f8e9d9eb514c6bd61db5eba3e5c', deadline: 1_800_000_000n },
    orderId: '0x003681abaec9f1c4b337b7b484def3895c7a37691192e8a68a38d8e68ef81500', payNonce: '0xf40911bdb7809d4c812f12e29d1e167815158dfebf98dbff8a2ce17ed2559cd9', refundNonce_123_2: '0xf6e5b04f8f594826a55e5e23e2a059e49b54df829a790f609b21b90535783ef4' },
  { order: { merchant: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', amount: 1n, ref: `0x${'ff'.repeat(32)}`, deadline: 18446744073709551615n },
    orderId: '0x80bd54c2134ce36da4925b167e876c4f9ceb85a072ece59f51f60e79cecd9074', payNonce: '0x436b715d221614338d31c493f9f86da21df0d193b1086d4bf28ca812d369d961', refundNonce_123_2: '0xa12748b6e675e97f53e3ad766d4086e3fffbcba152c519068661c08befa222a0' },
];
const PAYER: Address = '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967';
const PLANS: { plan: Plan; subId: Hex; subNonce: Hex; cancelDigest: Hex }[] = [
  { plan: { merchant: '0xc1dce946D192e344251972470237F1471C93876c', amount: 100_000n, period: 604800, cycles: 4, ref: '0x0df64e1884f7e3900fd11425a102176ea321def44ce555b22e5a146e86f6319f' },
    subId: '0x720fbbf606ec2697dea1883557c1d4fb4dfef9447883d1120f9a240daa633268', subNonce: '0x05c6be620dfe0448115863baef8b85ae650c9a89d33c7bf7a042cf3991ffaad7', cancelDigest: '0x74a155485babf64e32fc45251848f77abb369ca456e14d6cd0e7d66deb0d9da7' },
  { plan: { merchant: PAYER, amount: 7n, period: 1, cycles: 65535, ref: `0x${'01'.repeat(32)}` },
    subId: '0x6593ece25359004a38a83469c523a9c078c8d63693168e0e0dcb21fa7549c795', subNonce: '0x36776637e9a4d6d95289748534c84fa6d9a8adf976ed093d9b460620bd06856c', cancelDigest: '0xc91a4878dc629ce727f4836bf3462fcffc9657526b4fc39c9a7b57175acfa286' },
];

test('ids and nonces equal the deployed contract (on-chain vectors)', () => {
  assert.equal(orderRef('BJ-1042'), ORDERS[0].order.ref);
  for (const v of ORDERS) {
    assert.equal(orderId(v.order, CHECKOUT), v.orderId);
    assert.equal(payNonce(v.order, CHECKOUT), v.payNonce);
    assert.equal(refundNonce(v.orderId, 123n, 2), v.refundNonce_123_2);
  }
  for (const v of PLANS) {
    assert.equal(subId(v.plan, PAYER, CHECKOUT), v.subId);
    assert.equal(subNonce(v.plan, PAYER, CHECKOUT), v.subNonce);
    assert.equal(hashTypedData(cancelTypedData(v.subId, CHECKOUT) as never), v.cancelDigest);
  }
  assert.equal(domainSeparator({ domain: USDT_DOMAIN() }), '0xcdcfacb6b15c8238b4e5fbb47bdb83b7f83f50a531d264bf9763d2bd1d3d2a25', 'USDT DOMAIN_SEPARATOR on chain');
});

const payer = privateKeyToAccount(`0x${'aa'.repeat(32)}`);
const merchant = privateKeyToAccount(`0x${'bb'.repeat(32)}`);
const order: Order = { merchant: merchant.address, amount: 200_000n, ref: orderRef('BJ-2001'), deadline: BigInt(Math.floor(Date.now() / 1000) + 1800) };

test('typed data: each signature recovers to its signer and binds the right nonce', async () => {
  const pay = payTypedData(order, payer.address, { checkout: CHECKOUT });
  assert.equal(pay.primaryType, 'ReceiveWithAuthorization');
  assert.equal((pay.message as { nonce: Hex }).nonce, payNonce(order, CHECKOUT));
  assert.equal((pay.message as { to: Address }).to, CHECKOUT);
  assert.ok((pay.message as { validBefore: bigint }).validBefore <= order.deadline, 'never valid past the deadline');
  const s = await payer.signTypedData(pay as never);
  assert.equal(await recoverTypedDataAddress(Object.assign({}, pay, { signature: s }) as never), payer.address);

  const id = orderId(order, CHECKOUT);
  const ref = refundTypedData(id, merchant.address, 50_000n, 0, { checkout: CHECKOUT });
  assert.equal((ref.message as { from: Address }).from, merchant.address);
  assert.equal((ref.message as { nonce: Hex }).nonce, refundNonce(id, 50_000n, 0));
  const plan = PLANS[0].plan;
  const sub = subscribeTypedData(plan, payer.address, { checkout: CHECKOUT, permitNonce: 3n });
  assert.equal((sub.first.message as { nonce: Hex }).nonce, subNonce(plan, payer.address, CHECKOUT));
  assert.equal(sub.permitValue, 300_000n, 'permit covers the remaining 3 cycles');
  assert.equal((sub.permit.message as { nonce: bigint }).nonce, 3n);
  const ps = await payer.signTypedData(sub.permit as never);
  assert.equal(await recoverTypedDataAddress(Object.assign({}, sub.permit, { signature: ps }) as never), payer.address);
});

test('eth_signTypedData_v4 JSON hashes to the same digest; wallet chain mismatch switches, then adds the chain', async () => {
  const td = payTypedData(order, payer.address, { checkout: CHECKOUT });
  const parsed = JSON.parse(toEip712Json(td));
  assert.deepEqual(parsed.types.EIP712Domain.map((f: { name: string }) => f.name), ['name', 'version', 'chainId', 'verifyingContract']);
  assert.equal(typeof parsed.message.value, 'string');
  const calls: string[] = [];
  let switched = false;
  const eth = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      if (method === 'eth_requestAccounts') return [payer.address];
      if (method === 'wallet_switchEthereumChain') { throw Object.assign(new Error('Unrecognized chain'), { code: 4902 }); }
      if (method === 'wallet_addEthereumChain') { switched = true; assert.equal((params![0] as { chainId: string }).chainId, '0x752'); return null; }
      if (method === 'eth_signTypedData_v4') {
        if (!switched) throw new Error('Provided chainId "1874" must match the active chainId "11155111"');
        const j = JSON.parse(params![1] as string) as TypedData;
        const { EIP712Domain: _drop, ...types } = j.types as Record<string, never>;
        return payer.signTypedData({ domain: j.domain, types, primaryType: j.primaryType, message: j.message } as never);
      }
      throw new Error(method);
    },
  };
  const w = await walletSigner(eth);
  const sig = await w.signTypedData(td);
  assert.equal(await recoverTypedDataAddress(Object.assign({}, td, { signature: sig }) as never), payer.address);
  assert.deepEqual(calls, ['eth_requestAccounts', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_signTypedData_v4']);
});

function relayer() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body)) });
    if (path.startsWith('/checkout/order/')) return new Response(JSON.stringify({ id: path.split('/').pop(), status: 'paid', stage: stages.shift() ?? 'finalized' }));
    return new Response(JSON.stringify({ id: '0x01', txHash: `0x${'cd'.repeat(32)}`, explorer: 'https://x/tx' }));
  }) as typeof fetch;
  const stages: string[] = [];
  return { posts, f, stages };
}

test('payOrder / refundOrder / subscribe / cancel / charge send the agreed bodies', async () => {
  const r = relayer();
  const wallet = accountSigner(payer);
  await payOrder({ order, wallet, fetch: r.f });
  const pay = r.posts[0];
  assert.equal(pay.path, '/checkout/pay');
  assert.deepEqual(pay.body.order, { merchant: order.merchant, amount: '200000', ref: order.ref, deadline: order.deadline.toString() });
  assert.equal(pay.body.payer, payer.address);
  const td = payTypedData(order, payer.address, { checkout: CHECKOUT, validAfter: BigInt(pay.body.validAfter as string), validBefore: BigInt(pay.body.validBefore as string) });
  assert.equal(await recoverTypedDataAddress(Object.assign({}, td, { signature: pay.body.signature as Hex }) as never), payer.address, 'the relayer can verify what it got');

  await refundOrder({ id: ORDERS[0].orderId, amount: 1000n, refundNo: 1, wallet: accountSigner(merchant), fetch: r.f });
  assert.deepEqual(Object.keys(r.posts[1].body).sort(), ['amount', 'id', 'refundNo', 'signature', 'validAfter', 'validBefore']);
  await subscribe({ plan: PLANS[0].plan, wallet, permitNonce: 0n, fetch: r.f });
  const sb = r.posts[2].body as { first: { sig: Hex }; allowance: { validAfter: string; validBefore: string; sig: Hex }; plan: { period: number } };
  assert.equal(sb.allowance.validAfter, '300000', 'allowance = (permitValue, permitDeadline, permitSig)');
  assert.ok(sb.first.sig.length === 132 && sb.allowance.sig.length === 132);
  assert.equal(sb.plan.period, 604800);
  await cancelSubscription({ id: PLANS[0].subId, wallet, fetch: r.f });
  assert.deepEqual(r.posts[3].body.by, payer.address);
  assert.equal(r.posts[3].body.subId, PLANS[0].subId);
  await chargeSubscription({ id: PLANS[0].subId, fetch: r.f });
  assert.deepEqual(r.posts[4].body, { subId: PLANS[0].subId, id: PLANS[0].subId });
});

test('watchOrder reports every finality stage once, in order, then stops', async () => {
  const r = relayer();
  r.stages.push('sequencer', 'sequencer', 'finalized');
  const seen: string[] = [];
  await new Promise<void>((done) => watchOrder(ORDERS[0].orderId, (st) => { seen.push(st); if (st === 'finalized') done(); }, { fetch: r.f, intervalMs: 1 }));
  assert.deepEqual(seen, ['pending', 'sequencer', 'ethereum', 'finalized']);
});

test('wallet-mode button: attributes become the exact order the contract will see', async () => {
  const { orderFromAttributes } = await import('../src/element.ts');
  const attrs: Record<string, string> = { merchant: '0xc1dce946D192e344251972470237F1471C93876c', amount: '1.55', 'order-ref': 'BJ-1042', deadline: '30' };
  const o = orderFromAttributes((n) => attrs[n] ?? null, 1_800_000_000 - 1800);
  assert.deepEqual(o, ORDERS[0].order, 'same order as the on-chain vector');
  assert.equal(orderId(o, CHECKOUT), ORDERS[0].orderId);
  assert.equal(orderFromAttributes((n) => ({ ...attrs, amount: '0.000001' })[n] ?? null).amount, 1n);
  assert.throws(() => orderFromAttributes((n) => ({ ...attrs, amount: '1.2345678' })[n] ?? null), /amount/);
  assert.throws(() => orderFromAttributes((n) => ({ ...attrs, merchant: 'bluejay' })[n] ?? null), /merchant/);
  assert.throws(() => orderFromAttributes((n) => ({ ...attrs, 'order-ref': '' })[n] ?? null), /order-ref/);
});
