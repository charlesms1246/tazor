import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHandler } from '../src/app.ts';
import { USDT, USDT_DOMAIN, authorizationTypes, usdtAbi } from '../src/checkout/abi.ts';
import { createX402, decodeHeader, demoRequirements, encodeHeader, type X402Chain } from '../src/checkout/x402.ts';
import { createWebhooks } from '../src/webhooks.ts';

const NOW = 1_800_000_000;
const agent = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const PAY_TO: Address = getAddress('0xbc9a2fc48f141162eaff4c0767dac50362f96bc6');

function fake() {
  const s = { used: new Set<string>(), balance: 1_000_000n, simulateError: null as string | null, sent: [] as { to: Address; fn: string; args: readonly unknown[] }[] };
  let n = 0;
  const chain: X402Chain = {
    async read<T>(_to: Address, _abi: unknown, fn: string, args: readonly unknown[] = []) {
      if (fn === 'authorizationState') return s.used.has(`${String(args[0]).toLowerCase()}:${args[1]}`) as T;
      if (fn === 'balanceOf') return s.balance as T;
      throw new Error(`unexpected ${fn}`);
    },
    async simulate() { return s.simulateError ? { ok: false, error: s.simulateError } : { ok: true }; },
    async send(to, data) {
      const d = decodeFunctionData({ abi: usdtAbi, data });
      s.sent.push({ to, fn: d.functionName, args: d.args ?? [] });
      const a = d.args as unknown as unknown[];
      s.used.add(`${String(a[0]).toLowerCase()}:${a[5]}`);
      return `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
    },
    async wait() { return { status: 'success', blockNumber: 1n }; },
  };
  return { s, chain };
}

const requirements = demoRequirements('https://relayer.test/x402/demo/freight-quote?from=Mumbai&to=Pune', PAY_TO);
async function payload(over: Partial<{ to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex }> = {}, signer = agent) {
  const authorization = {
    from: agent.address, to: over.to ?? PAY_TO, value: over.value ?? '10000',
    validAfter: over.validAfter ?? String(NOW - 60), validBefore: over.validBefore ?? String(NOW + 300), nonce: over.nonce ?? (`0x${'07'.repeat(32)}` as Hex),
  };
  const signature = await signer.signTypedData({
    domain: USDT_DOMAIN, types: authorizationTypes, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 1, scheme: 'exact', network: 'whitechain-sepolia', payload: { signature, authorization } };
}
const req = (paymentPayload: unknown, r = requirements) => ({ x402Version: 1, paymentPayload, paymentRequirements: r });

test('x402 supported: exact on eip155:1874 (primary) and the alias whitechain-sepolia', () => {
  const x = createX402({ chain: fake().chain });
  assert.deepEqual(x.supported(), { kinds: [{ x402Version: 1, scheme: 'exact', network: 'eip155:1874' }, { x402Version: 1, scheme: 'exact', network: 'whitechain-sepolia' }] });
});

test('x402 verify: a real EIP-712 TransferWithAuthorization on the USDT domain is valid; every drain or misuse is rejected with the x402 reason', async () => {
  const { s, chain } = fake();
  const x = createX402({ chain, now: () => NOW * 1000 });
  assert.deepEqual(await x.verify(req(await payload())), { isValid: true, payer: agent.address });
  assert.equal((await x.verify(req({ ...(await payload()), network: 'eip155:1874' }))).isValid, true);
  assert.equal((await x.verify(req(await payload(), { ...requirements, network: 'whitechain-sepolia' }))).isValid, true, 'the alias is still accepted');
  const reason = async (p: unknown, r = requirements) => (await x.verify(req(p, r))).invalidReason;
  assert.equal(await reason(await payload({ value: '20000' })), 'invalid_exact_evm_payload_authorization_value', 'overpaying is refused (exact)');
  assert.equal(await reason(await payload({ value: '9999' })), 'invalid_exact_evm_payload_authorization_value');
  assert.equal(await reason(await payload({ to: getAddress(`0x${'33'.repeat(20)}`) })), 'invalid_exact_evm_payload_recipient_mismatch');
  assert.equal(await reason(await payload({ validAfter: String(NOW + 10) })), 'invalid_exact_evm_payload_authorization_valid_after');
  assert.equal(await reason(await payload({ validBefore: String(NOW + 3) })), 'invalid_exact_evm_payload_authorization_valid_before');
  assert.equal(await reason(await payload({ validBefore: String(NOW + 3601) })), 'invalid_exact_evm_payload_authorization_valid_before', 'at most 1 h');
  const other = await payload({}, privateKeyToAccount(`0x${'43'.repeat(32)}`));
  assert.equal(await reason(other), 'invalid_exact_evm_payload_signature', 'signed by someone else');
  const tampered = await payload();
  tampered.payload.authorization.nonce = `0x${'08'.repeat(32)}`;
  assert.equal(await reason(tampered), 'invalid_exact_evm_payload_signature');
  assert.equal(await reason({ ...(await payload()), network: 'base-sepolia' }), 'invalid_network');
  assert.equal(await reason({ ...(await payload()), scheme: 'upto' }), 'invalid_scheme');
  assert.equal(await reason(await payload(), { ...requirements, asset: getAddress(`0x${'44'.repeat(20)}`) }), 'invalid_payment_requirements');
  s.balance = 5n;
  assert.equal(await reason(await payload()), 'insufficient_funds');
  s.balance = 1_000_000n;
  s.used.add(`${agent.address.toLowerCase()}:0x${'07'.repeat(32)}`);
  assert.equal(await reason(await payload()), 'invalid_transaction_state', 'nonce already used');
  s.used.clear();
  s.simulateError = 'execution reverted: FiatToken: invalid signature';
  assert.equal(await reason(await payload()), 'invalid_exact_evm_payload_signature');
  assert.equal(s.sent.length, 0, 'verify never sends');
});

test('x402 settle: verify + guard + transferWithAuthorization(bytes sig) to USDT, receipt; x402.settled recorded; a replay fails', async () => {
  const { s, chain } = fake();
  const webhooks = createWebhooks({ endpoints: {} });
  const x = createX402({ chain, now: () => NOW * 1000, webhooks });
  const guarded: Address[] = [];
  const p = await payload();
  const r = await x.settle(req(p), async (payer) => { guarded.push(payer); });
  assert.deepEqual(r, { success: true, transaction: `0x${'1'.padStart(64, '0')}`, network: 'eip155:1874', payer: agent.address });
  assert.deepEqual(guarded, [agent.address]);
  assert.equal(s.sent[0].to, USDT);
  assert.equal(s.sent[0].fn, 'transferWithAuthorization');
  assert.deepEqual(s.sent[0].args, [agent.address, PAY_TO, 10000n, BigInt(NOW - 60), BigInt(NOW + 300), `0x${'07'.repeat(32)}`, p.payload.signature]);
  const replay = await x.settle(req(p));
  assert.deepEqual([replay.success, replay.errorReason, replay.transaction], [false, 'invalid_transaction_state', '']);
  assert.deepEqual((await x.settlements(PAY_TO)).map((i) => [i.payer, i.amount, i.txHash]), [[agent.address, '10000', r.transaction]]);
});

test('HTTP: facilitator routes, and the demo paid resource (402 → pay with X-PAYMENT → 200 + X-PAYMENT-RESPONSE)', async () => {
  const { chain } = fake();
  const webhooks = createWebhooks({ endpoints: {} });
  const x402 = createX402({ chain, now: () => Date.now(), webhooks });
  const srv = createServer(createHandler({ x402, webhooks, x402PayTo: PAY_TO }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  assert.equal((await (await fetch(`${base}/x402/supported`)).json()).kinds.length, 2);

  const first = await fetch(`${base}/x402/demo/freight-quote?from=Mumbai&to=Pune`);
  assert.equal(first.status, 402);
  const body = await first.json();
  assert.equal(body.x402Version, 1);
  const accepts = body.accepts[0];
  assert.deepEqual([accepts.scheme, accepts.network, accepts.maxAmountRequired, accepts.payTo, accepts.asset, accepts.extra], ['exact', 'eip155:1874', '10000', PAY_TO, USDT, { name: 'Tether USD', version: '1' }]);

  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: agent.address, to: PAY_TO, value: '10000', validAfter: String(now - 60), validBefore: String(now + 300), nonce: `0x${'09'.repeat(32)}` as Hex };
  const signature = await agent.signTypedData({ domain: USDT_DOMAIN, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message: { ...authorization, value: 10000n, validAfter: BigInt(now - 60), validBefore: BigInt(now + 300) } });
  const header = encodeHeader({ x402Version: 1, scheme: 'exact', network: 'whitechain-sepolia', payload: { signature, authorization } });
  const paid = await fetch(`${base}/x402/demo/freight-quote?from=Mumbai&to=Pune`, { headers: { 'x-payment': header } });
  assert.equal(paid.status, 200);
  const quote = await paid.json();
  assert.deepEqual([quote.from, quote.to, quote.distanceKm, quote.simulated], ['Mumbai', 'Pune', 148, true]);
  const response = decodeHeader(paid.headers.get('x-payment-response')!) as { success: boolean; transaction: string; payer: string };
  assert.deepEqual([response.success, response.payer], [true, agent.address]);
  assert.equal(paid.headers.get('access-control-expose-headers'), 'x-payment-response');

  const again = await fetch(`${base}/x402/demo/freight-quote?from=Mumbai&to=Pune`, { headers: { 'x-payment': header } });
  assert.equal(again.status, 402, 'the same payment cannot buy twice');
  assert.equal((await again.json()).error, 'invalid_transaction_state');

  const settlements = await (await fetch(`${base}/x402/settlements?payTo=${PAY_TO}`)).json();
  assert.equal(settlements.items.length, 1);
  assert.match(settlements.note, /this server instance/);
  const verify = await (await fetch(`${base}/x402/verify`, { method: 'POST', body: JSON.stringify(req({ x402Version: 1, scheme: 'exact', network: 'whitechain-sepolia', payload: { signature, authorization } }, { ...accepts })) })).json();
  assert.deepEqual(verify, { isValid: false, invalidReason: 'invalid_transaction_state', payer: agent.address });
});
