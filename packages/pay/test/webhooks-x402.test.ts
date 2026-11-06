import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSignatureHeader, signWebhook, verifyWebhook } from '../src/webhooks.ts';
import { decodePaymentHeader, decodePaymentResponse, encodePaymentHeader, payFetch, pickRequirement, type PaymentRequirements } from '../src/x402.ts';
import { accountSigner, TRANSFER_TYPES, USDT } from '../src/checkout.ts';

const SECRET = 'whsec_test_demo';
const body = JSON.stringify({ id: 'evt_1', type: 'order.paid', created: 1793990000, data: { amount: '200000' }, chainId: 1874, txHash: `0x${'ab'.repeat(32)}` });

test('webhooks: a valid signature verifies; tampering, wrong secret, stale time and bad headers are refused', async () => {
  const t = 1793990000;
  const h = await signWebhook(body, SECRET, t);
  assert.match(h, /^t=1793990000,v1=[0-9a-f]{64}$/);
  const ok = await verifyWebhook(body, h, SECRET, 300, t + 10);
  assert.ok(ok.ok && ok.event.type === 'order.paid');
  assert.deepEqual(await verifyWebhook(body.replace('200000', '900000'), h, SECRET, 300, t), { ok: false, reason: 'signature does not match' });
  assert.equal((await verifyWebhook(body, h, 'other', 300, t)).ok, false);
  assert.match((await verifyWebhook(body, h, SECRET, 300, t + 301)) .ok ? '' : 'replay', /replay/);
  assert.equal((await verifyWebhook(body, 'garbage', SECRET, 300, t)).ok, false);
  assert.equal((await verifyWebhook(body, null, SECRET)).ok, false);
  // secret rotation: any matching v1 passes
  const h2 = `${h},v1=${'0'.repeat(64)}`;
  assert.ok((await verifyWebhook(body, h2, SECRET, 300, t)).ok);
  assert.deepEqual(parseSignatureHeader('t=1,v1=' + 'a'.repeat(64)), { t: 1, v1: ['a'.repeat(64)] });
});

const agent = privateKeyToAccount(`0x${'cc'.repeat(32)}`);
const PAY_TO = '0xc1dce946D192e344251972470237F1471C93876c';
const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact', network: 'whitechain-sepolia', maxAmountRequired: '10000', resource: 'https://r/x402/demo/freight-quote',
  payTo: PAY_TO, maxTimeoutSeconds: 120, asset: USDT, extra: { name: 'Tether USD', version: '1' }, ...over,
});

test('x402: picks the Whitechain USDT exact requirement, pays once with a valid 3009 signature, decodes the receipt', async () => {
  assert.deepEqual(pickRequirement([req({ network: 'base-sepolia' }), req({ asset: '0x0000000000000000000000000000000000000001' }), req()]), req());
  assert.equal(pickRequirement([req({ network: 'base' })]), null);
  let paid: string | null = null;
  const f = (async (_u: string, init?: RequestInit) => {
    const x = new Headers(init?.headers).get('X-PAYMENT');
    if (!x) return new Response(JSON.stringify({ x402Version: 1, accepts: [req({ network: 'eip155:1874' })], error: 'payment required' }), { status: 402 });
    paid = x;
    const receipt = btoa(JSON.stringify({ success: true, transaction: `0x${'ef'.repeat(32)}`, network: 'whitechain-sepolia', payer: agent.address }));
    return new Response(JSON.stringify({ quote: { lane: 'Mumbai → Pune', price: '1.20 USDT' } }), { status: 200, headers: { 'X-PAYMENT-RESPONSE': receipt } });
  }) as typeof fetch;
  const r = await payFetch('https://r/x402/demo/freight-quote', { account: accountSigner(agent), maxValue: 10_000n, fetch: f });
  assert.equal(r.response.status, 200);
  assert.equal(r.paid?.value, 10_000n);
  assert.equal(r.paid?.settlement?.transaction, `0x${'ef'.repeat(32)}`);
  const p = decodePaymentHeader(paid!);
  assert.equal(p.network, 'eip155:1874');
  assert.equal(p.payload.authorization.to, PAY_TO);
  const a = p.payload.authorization;
  assert.ok(Number(a.validBefore) - Number(a.validAfter) <= 3600, 'within the facilitator window');
  const signer = await recoverTypedDataAddress({
    domain: { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT }, types: TRANSFER_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: p.payload.signature as Hex,
  });
  assert.equal(signer, agent.address);
  assert.deepEqual(decodePaymentHeader(encodePaymentHeader(p)), p);
  assert.equal(decodePaymentResponse('not base64!'), null);
});

test('x402: the spend cap refuses before signing; no requirement → a clear error; non-402 passes through', async () => {
  let signed = false;
  const account = { ...accountSigner(agent), signTypedData: async () => { signed = true; return '0x' as Hex; } };
  const f402 = (async () => new Response(JSON.stringify({ x402Version: 1, accepts: [req({ maxAmountRequired: '10001' })] }), { status: 402 })) as typeof fetch;
  await assert.rejects(payFetch('https://r', { account, maxValue: 10_000n, fetch: f402 }), /exceeds the spend cap 10000/);
  assert.equal(signed, false);
  const fNone = (async () => new Response(JSON.stringify({ x402Version: 1, accepts: [req({ network: 'base' })] }), { status: 402 })) as typeof fetch;
  await assert.rejects(payFetch('https://r', { account, maxValue: 1n, fetch: fNone }), /No payable requirement/);
  const f200 = (async () => new Response('free', { status: 200 })) as typeof fetch;
  assert.equal((await payFetch('https://r', { account, maxValue: 0n, fetch: f200 })).paid, null);
});
