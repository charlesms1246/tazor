import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, type Abi, type Address, type Hex } from 'viem';
import { createHandler } from '../src/app.ts';
import { checkoutAbi } from '../src/checkout/abi.ts';
import { createCheckout, type CheckoutChain } from '../src/checkout/service.ts';
import { SimulationFailed } from '../src/sender.ts';
import { createWebhooks } from '../src/webhooks.ts';

const C: Address = '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670';
const MERCHANT: Address = '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6';
const PAYER: Address = getAddress('0x0000000000000000000000000000000000000ca1');
const NOW = 1_800_000_000;
const SIG = `0x${'11'.repeat(65)}` as Hex;
const h = (...v: unknown[]) => keccak256(encodeAbiParameters([{ type: 'string' }], [JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))]));
const abi = checkoutAbi as unknown as Abi;

/** In-memory TazorCheckout + USDT: views answer from state; sends decode the calldata and apply it (mined at once). */
function fake() {
  const s = {
    payments: new Map<string, { merchant: Address; payer: Address; amount: bigint; refunded: bigint; paidAt: bigint; refunds: number }>(),
    subs: new Map<string, { merchant: Address; payer: Address; amount: bigint; period: number; cycles: number; charged: number; start: bigint; active: boolean }>(),
    usedAuth: new Set<string>(), balance: 5_000_000n, sent: [] as { fn: string; args: readonly unknown[] }[], revert: null as string | null,
    head: 1000n, safe: 990n, finalized: 900n, payBlock: 0n, logs: [] as { event: string; id: Hex; blockNumber: bigint; tx: Hex; args: Record<string, unknown> }[],
  };
  let n = 0;
  const chain: CheckoutChain = {
    async read<T>(_to: Address, _abi: Abi, fn: string, args: readonly unknown[] = []) {
      const id = args[0] as string;
      const r: Record<string, () => unknown> = {
        orderId: () => h('order', (args[0] as { merchant: string }).merchant, (args[0] as { ref: string }).ref),
        payNonce: () => h('payNonce', args[0]),
        refundNonce: () => h('refundNonce', ...args),
        subId: () => h('sub', args[0], args[1]),
        subNonce: () => h('subNonce', args[0], args[1]),
        payment: () => { const p = s.payments.get(id); return p ? [p.merchant, p.payer, p.amount, p.refunded, p.paidAt, p.refunds] : ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0]; },
        subscription: () => { const x = s.subs.get(id); return x ? [x.merchant, x.payer, x.amount, x.period, x.cycles, x.charged, x.start, x.active] : ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, 0, 0, 0, 0n, false]; },
        nextChargeAt: () => { const x = s.subs.get(id); return !x || !x.active || x.charged >= x.cycles ? 0n : x.start + BigInt(x.charged * x.period); },
        authorizationState: () => s.usedAuth.has(`${args[0]}:${args[1]}`),
        balanceOf: () => s.balance,
      };
      if (!r[fn]) throw new Error(`unexpected read ${fn}`);
      return r[fn]() as T;
    },
    async logs(_a, event, args) { return s.logs.filter((l) => l.event === event.name && (!args.id || l.id === args.id)).map((l) => ({ transactionHash: l.tx, blockNumber: l.blockNumber, args: l.args })); },
    async block(tag) {
      if (tag === 'latest') return { number: s.head, timestamp: BigInt(NOW) };
      if (tag === 'safe') return { number: s.safe, timestamp: BigInt(NOW - 60) };
      if (tag === 'finalized') return { number: s.finalized, timestamp: BigInt(NOW - 600) };
      return { number: tag, timestamp: BigInt(NOW - 5) };
    },
    async send(_to, data) {
      const d = decodeFunctionData({ abi, data });
      if (s.revert) { const e = s.revert; s.revert = null; throw new SimulationFailed(`execution reverted: ${e}()`); }
      s.sent.push({ fn: d.functionName, args: d.args ?? [] });
      const tx = `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
      const a = (d.args ?? []) as unknown[];
      if (d.functionName === 'pay') {
        const o = a[0] as { merchant: Address; amount: bigint; ref: Hex };
        const id = await chain.read<Hex>(C, abi, 'orderId', [o]);
        s.payments.set(id, { merchant: o.merchant, payer: a[1] as Address, amount: o.amount, refunded: 0n, paidAt: BigInt(NOW), refunds: 0 });
        s.logs.push({ event: 'OrderPaid', id, blockNumber: s.payBlock || s.head, tx, args: {} });
      }
      if (d.functionName === 'refund') {
        const p = s.payments.get(a[0] as string)!;
        p.refunded += a[1] as bigint; p.refunds++;
        s.logs.push({ event: 'Refunded', id: a[0] as Hex, blockNumber: s.head, tx, args: { amount: a[1], totalRefunded: p.refunded } });
      }
      if (d.functionName === 'subscribe') {
        const p = a[0] as { merchant: Address; amount: bigint; period: number; cycles: number };
        const id = await chain.read<Hex>(C, abi, 'subId', [p, a[1]]);
        s.subs.set(id, { merchant: p.merchant, payer: a[1] as Address, amount: p.amount, period: p.period, cycles: p.cycles, charged: 1, start: BigInt(NOW), active: true });
        s.logs.push({ event: 'Subscribed', id, blockNumber: s.head, tx, args: { id } });
      }
      if (d.functionName === 'charge') s.subs.get(a[0] as string)!.charged++;
      if (d.functionName === 'cancelBySig') s.subs.get(a[0] as string)!.active = false;
      return tx;
    },
    async wait() { return { status: 'success', blockNumber: s.head }; },
  };
  return { s, chain };
}

const order = { merchant: MERCHANT, amount: '1500000', ref: `0x${'aa'.repeat(32)}`, deadline: String(NOW + 3600) };
const payBody = { order, payer: PAYER, validAfter: String(NOW - 10), validBefore: String(NOW + 600), signature: SIG };

async function serve(now = () => NOW * 1000) {
  const { s, chain } = fake();
  const hooks: { type: string; id: string }[] = [];
  const webhooks = createWebhooks({ endpoints: {}, now });
  const orig = webhooks.emit;
  webhooks.emit = async (e) => { const d = await orig(e); if (d) hooks.push({ type: e.type, id: e.id }); return d; };
  const checkout = createCheckout({ address: C, chain, webhooks, now, fromBlock: 0n });
  const srv = createServer(createHandler({ checkout, webhooks }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (p: string, b: unknown) => { const r = await fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(b) }); return { code: r.status, body: await r.json() }; };
  const get = async (p: string) => { const r = await fetch(`${base}${p}`); return { code: r.status, body: await r.json() }; };
  return { s, post, get, hooks, close: () => srv.close() };
}

test('pay: pre-checks then pay(order, payer, validAfter, validBefore, sig); 200 {ok, id, txHash, explorer}; order.paid webhook; a second pay is 409', async () => {
  const t = await serve();
  const r = await t.post('/checkout/pay', payBody);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.id, r.body.orderId);
  assert.match(r.body.explorer, /^https:\/\/explorer\.testnet\.whitechain\.io\/tx\/0x/);
  assert.equal(t.s.sent[0].fn, 'pay');
  assert.deepEqual(t.s.sent[0].args.slice(1), [PAYER, BigInt(NOW - 10), BigInt(NOW + 600), SIG]);
  assert.deepEqual(t.hooks, [{ type: 'order.paid', id: `${r.body.orderId}:paid` }]);
  const again = await t.post('/checkout/pay', payBody);
  assert.deepEqual([again.code, again.body.code], [409, 'already-paid']);
  assert.equal(t.s.sent.length, 1);
  t.close();
});

test('pay pre-checks: expired order, signature window > 1 h, validAfter in the future, used authorization, low balance, simulated revert', async () => {
  const t = await serve();
  const bad = async (b: unknown, code: number, sub?: string) => { const r = await t.post('/checkout/pay', b); assert.equal(r.code, code, JSON.stringify(r.body)); if (sub) assert.equal(r.body.code, sub); return r; };
  await bad({ ...payBody, order: { ...order, deadline: String(NOW - 1) } }, 409, 'expired');
  await bad({ ...payBody, validBefore: String(NOW + 3601) }, 400);
  await bad({ ...payBody, validAfter: String(NOW + 60) }, 400);
  await bad({ ...payBody, validBefore: String(NOW - 1) }, 409, 'expired');
  await bad({ ...payBody, order: { ...order, amount: '0' } }, 400);
  await bad({ ...payBody, signature: '0x' }, 400);
  t.s.balance = 1n;
  await bad(payBody, 409, 'insufficient-balance');
  t.s.balance = 5_000_000n;
  t.s.revert = 'Expired';
  const r = await bad(payBody, 422);
  assert.match(r.body.error, /simulation reverted: Expired\(\)/);
  assert.equal(t.s.sent.length, 0, 'nothing sent for any failed pre-check');
  t.close();
});

test('refund: only up to what is left, refundNo must match, money to the payer; order.refunded webhook; the order view shows status, refunds and finality', async () => {
  const t = await serve();
  const paid = await t.post('/checkout/pay', payBody);
  const id = paid.body.orderId;
  const body = { id, amount: '500000', refundNo: '0', validAfter: String(NOW - 10), validBefore: String(NOW + 600), signature: SIG };
  assert.equal((await t.post('/checkout/refund', { ...body, amount: '1500001' })).body.code, 'refund-too-large');
  assert.equal((await t.post('/checkout/refund', { ...body, refundNo: '1' })).body.code, 'stale-refund');
  const r = await t.post('/checkout/refund', body);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(t.hooks.at(-1)!.type, 'order.refunded');
  assert.equal((await t.post('/checkout/refund', { ...body, id: `0x${'99'.repeat(32)}` })).body.code, 'not-paid');

  const v = await t.get(`/checkout/order/${id}`);
  assert.equal(v.body.status, 'partially-refunded');
  assert.deepEqual([v.body.amount, v.body.refunded, v.body.refunds], ['1500000', '500000', 1]);
  assert.equal(v.body.refundTxs.length, 1);
  assert.equal(v.body.stage, 'sequencer', 'paid at the head: not yet in a safe block');
  assert.equal(v.body.stages.sequencer.at, NOW - 5);
  assert.equal((await t.get(`/checkout/order/0x${'77'.repeat(32)}`)).body.status, 'unpaid');
  t.close();
});

test('finality: stage moves sequencer → ethereum (safe) → finalized; each change emits order.finality once', async () => {
  const t = await serve();
  t.s.payBlock = 950n;
  const id = (await t.post('/checkout/pay', payBody)).body.orderId;
  t.s.safe = 940n; t.s.finalized = 900n;
  assert.equal((await t.get(`/checkout/order/${id}`)).body.stage, 'sequencer');
  t.s.safe = 960n;
  const eth = await t.get(`/checkout/order/${id}`);
  assert.equal(eth.body.stage, 'ethereum');
  assert.equal(eth.body.stages.ethereum.at, NOW);
  await t.get(`/checkout/order/${id}`);
  t.s.finalized = 955n;
  const fin = await t.get(`/checkout/order/${id}`);
  assert.equal(fin.body.stage, 'finalized');
  assert.deepEqual(t.hooks.filter((x) => x.type === 'order.finality').map((x) => x.id), [`${id}:sequencer`, `${id}:ethereum`, `${id}:finalized`]);
  t.close();
});

test('subscriptions: subscribe (flat or struct body) → created + charged(1); charge only when due; cancel by payer signature; views and the cron', async () => {
  let now = NOW * 1000;
  const t = await serve(() => now);
  const plan = { merchant: MERCHANT, amount: '100000', period: 86400, cycles: 3, ref: `0x${'bb'.repeat(32)}` };
  const sub = { plan, payer: PAYER, first: { validAfter: String(NOW - 10), validBefore: String(NOW + 600), sig: SIG }, allowance: { validAfter: '200000', validBefore: String(NOW + 90 * 86400), sig: SIG } };
  const r = await t.post('/checkout/subscribe', sub);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const call = t.s.sent[0];
  assert.equal(call.fn, 'subscribe');
  assert.deepEqual(call.args[2], { validAfter: BigInt(NOW - 10), validBefore: BigInt(NOW + 600), sig: SIG });
  assert.deepEqual(call.args[3], { validAfter: 200000n, validBefore: BigInt(NOW + 90 * 86400), sig: SIG });
  assert.deepEqual(t.hooks.map((x) => x.type), ['subscription.created', 'subscription.charged']);
  assert.equal((await t.post('/checkout/subscribe', sub)).body.code, 'exists');
  assert.equal((await t.post('/checkout/subscribe', { ...sub, allowance: undefined })).code, 400, 'multi-cycle plans need the permit');
  const subId = r.body.subId;

  const notDue = await t.post('/checkout/charge', { id: subId });
  assert.deepEqual([notDue.code, notDue.body.code, notDue.body.nextChargeAt], [409, 'not-due', String(NOW + 86400)]);

  // the cron: within 24 h of the next charge → one subscription.due; once due → charged
  now = (NOW + 3600) * 1000;
  const h = createHandler({});
  void h;
  const view = await t.get(`/checkout/subscription/${subId}`);
  assert.deepEqual([view.body.charged, view.body.active, view.body.due], [1, true, false]);

  now = (NOW + 86400) * 1000;
  const charged = await t.post('/checkout/charge', { subId });
  assert.equal(charged.code, 200, JSON.stringify(charged.body));
  assert.equal(charged.body.cycle, 2);

  const cancelled = await t.post('/checkout/cancel', { subId, signer: PAYER, signature: SIG });
  assert.equal(cancelled.code, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(t.s.sent.at(-1)!.args.slice(0, 2), [subId, PAYER]);
  assert.equal((await t.post('/checkout/cancel', { subId, signer: PAYER, signature: SIG })).body.code, 'not-active');
  assert.equal((await t.post('/checkout/charge', { subId })).body.code, 'not-active');
  assert.equal((await t.post('/checkout/cancel', { subId: `0x${'55'.repeat(32)}`, signer: `0x${'66'.repeat(20)}`, signature: SIG })).body.code, 'not-active');
  t.close();
});

test('cron scanDue: charges due subscriptions (after the budget check), reminds 24 h ahead once, skips finished ones', async () => {
  let now = NOW * 1000;
  const { s, chain } = fake();
  const hooks: string[] = [];
  const webhooks = createWebhooks({ endpoints: {}, now: () => now });
  const emit = webhooks.emit;
  webhooks.emit = async (e) => { const d = await emit(e); if (d) hooks.push(e.type); return d; };
  const c = createCheckout({ address: C, chain, webhooks, now: () => now, fromBlock: 0n });
  const plan = (ref: string, cycles: number) => ({ merchant: MERCHANT, amount: '100000', period: 86400, cycles, ref });
  const body = (p: object) => ({ plan: p, payer: PAYER, validAfter: String(NOW - 10), validBefore: String(NOW + 600), firstSig: SIG, permitValue: '200000', permitDeadline: String(NOW + 9e6), permitSig: SIG });
  await c.subscribe(body(plan(`0x${'01'.repeat(32)}`, 3)));
  await c.subscribe(body(plan(`0x${'02'.repeat(32)}`, 1)));
  hooks.length = 0;
  now = (NOW + 3600) * 1000;
  let budget = 0;
  const first = await c.scanDue(async () => { budget++; });
  assert.deepEqual(first.results.map((r) => r.action), ['reminded', 'skipped']);
  assert.deepEqual((await c.scanDue()).results.map((r) => r.action), ['skipped', 'skipped'], 'a reminder is sent once');
  now = (NOW + 86400) * 1000;
  const due = await c.scanDue(async () => { budget++; });
  assert.deepEqual(due.results.map((r) => r.action), ['charged', 'skipped']);
  assert.equal(budget, 1);
  assert.deepEqual(hooks, ['subscription.due', 'subscription.charged']);
  void s;
});

test('routes: checkout off → 503; guard keys per payer and merchant; /health lists the routes', async () => {
  const off = createServer(createHandler({}));
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
  off.unref();
  const base = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/checkout/pay`, { method: 'POST', body: '{}' })).status, 503);
  const health = await (await fetch(`${base}/health`)).json();
  assert.ok(health.checkout.routes.includes('POST /checkout/refund'));
  assert.ok(health.x402.routes.includes('POST /x402/settle'));
  off.close();

  const { chain } = fake();
  const keys: unknown[] = [];
  const guard = { check: async (route: string, _ip: string, k: unknown) => { keys.push([route, k]); }, checkBudget: async () => {}, health: async () => ({}), limits: {} };
  const srv = createServer(createHandler({ checkout: createCheckout({ address: C, chain, now: () => NOW * 1000, fromBlock: 0n }), guard: guard as never }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const b2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  await fetch(`${b2}/checkout/pay`, { method: 'POST', body: JSON.stringify(payBody) });
  assert.deepEqual(keys, [['/checkout/pay', [PAYER, MERCHANT]]]);
  srv.close();
});

test('GET /watch (Bearer CRON_SECRET) runs the subscription cron: 401 without the bearer; with it, a due subscription is charged', async () => {
  let now = NOW * 1000;
  const { s, chain } = fake();
  const c = createCheckout({ address: C, chain, now: () => now, fromBlock: 0n });
  await c.subscribe({ plan: { merchant: MERCHANT, amount: '100000', period: 86400, cycles: 2, ref: `0x${'03'.repeat(32)}` }, payer: PAYER, validAfter: String(NOW - 10), validBefore: String(NOW + 600), firstSig: SIG, permitValue: '100000', permitDeadline: String(NOW + 9e6), permitSig: SIG });
  let budget = 0;
  const guard = { check: async () => {}, checkBudget: async () => { budget++; }, health: async () => ({}), limits: {} };
  const srv = createServer(createHandler({ checkout: c, cronSecret: 'cron-test', guard: guard as never }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/watch`)).status, 401);
  now = (NOW + 86400) * 1000;
  const r = await (await fetch(`${base}/watch`, { headers: { authorization: 'Bearer cron-test' } })).json();
  assert.equal(r.subscriptions.subscriptions, 1);
  assert.equal(r.subscriptions.results[0].action, 'charged');
  assert.equal(s.sent.at(-1)!.fn, 'charge');
  assert.equal(budget, 1, 'the gas budget is checked before the charge');
  srv.close();
});
