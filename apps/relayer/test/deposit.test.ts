import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, getAddress, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { createHandler } from '../src/app.ts';
import { depositAbi } from '../src/checkout/deposit-abi.ts';
import { createDeposit } from '../src/checkout/deposit.ts';
import type { CheckoutChain } from '../src/checkout/service.ts';
import { createWebhooks } from '../src/webhooks.ts';

const D: Address = '0xcb3515398C8Cd9459a1Dce75aB42ec664a07B3ab';
const MERCHANT = getAddress('0xbc9a2fc48f141162eaff4c0767dac50362f96bc6');
const CUSTOMER = getAddress('0x0000000000000000000000000000000000000c05');
const VAULT = getAddress('0x00000000000000000000000000000000000000fa');
const NOW = 1_800_000_000;
const SIG = `0x${'11'.repeat(65)}` as Hex;

function fake() {
  const s = { vault: 0n, merchant: 1_000_000n, paid: null as null | { amount: bigint; refunded: bigint; refunds: number }, sent: [] as string[], head: 100n, safe: 50n, finalized: 10n, payBlock: 0n };
  const ID = keccak256(toHex('order'));
  let n = 0;
  const chain: CheckoutChain = {
    async read<T>(to: Address, _abi: Abi, fn: string, args: readonly unknown[] = []) {
      const r: Record<string, () => unknown> = {
        orderId: () => ID, depositAddress: () => VAULT, refundNonce: () => keccak256(toHex(`r${args[2]}`)),
        payment: () => (s.paid ? [MERCHANT, CUSTOMER, s.paid.amount, s.paid.refunded, BigInt(NOW), s.paid.refunds] : ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0]),
        balanceOf: () => (getAddress(args[0] as string) === VAULT ? s.vault : s.merchant),
        authorizationState: () => false,
      };
      void to;
      return r[fn]() as T;
    },
    async logs() { return s.paid ? [{ transactionHash: `0x${'aa'.repeat(32)}` as Hex, blockNumber: s.payBlock, args: {} }] : []; },
    async block(tag) { return { number: tag === 'safe' ? s.safe : tag === 'finalized' ? s.finalized : s.head, timestamp: BigInt(NOW) }; },
    async send(_to, data) {
      const d = decodeFunctionData({ abi: depositAbi as unknown as Abi, data });
      s.sent.push(d.functionName);
      if (d.functionName === 'settle') { s.paid = { amount: (d.args![0] as { amount: bigint }).amount, refunded: 0n, refunds: 0 }; s.vault = 0n; s.payBlock = s.head; }
      if (d.functionName === 'refund') { s.paid!.refunded += d.args![1] as bigint; s.paid!.refunds++; }
      return `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
    },
    async wait() { return { status: 'success', blockNumber: s.head }; },
  };
  return { s, chain, ID };
}

const order = { merchant: MERCHANT, amount: '200000', ref: `0x${'cc'.repeat(32)}`, deadline: String(NOW + 3600), refundTo: CUSTOMER };
const q = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('deposit status: awaiting → underpaid → funded settles on the poll (guarded per merchant), order.paid source "deposit", then finality', async () => {
  const { s, chain, ID } = fake();
  const hooks: string[] = [];
  const webhooks = createWebhooks({ endpoints: {} });
  const emit = webhooks.emit;
  webhooks.emit = async (e) => { const d = await emit(e); if (d) hooks.push(`${e.type}:${String(e.data.source)}`); return d; };
  const deposit = createDeposit({ address: D, chain, webhooks, now: () => NOW * 1000 });
  const keys: unknown[] = [];
  const guard = { check: async (route: string, _ip: string, k: unknown) => { keys.push([route, k]); }, checkBudget: async () => {}, health: async () => ({}), limits: {} };
  const srv = createServer(createHandler({ deposit, webhooks, guard: guard as never }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const status = async () => (await (await fetch(`${base}/checkout/deposit/status?order=${q(order)}`)).json());

  let st = await status();
  assert.deepEqual([st.status, st.depositAddress, st.paid, st.balance], ['awaiting-transfer', VAULT, false, '0']);
  s.vault = 150_000n;
  assert.equal((await status()).status, 'underpaid');
  assert.equal(s.sent.length, 0);
  s.vault = 250_000n;
  st = await status();
  assert.equal(st.status, 'paid');
  assert.equal(st.settledNow, `0x${'1'.padStart(64, '0')}`);
  assert.equal(st.stage, 'sequencer', 'settled at the head: not yet in a safe block');
  assert.deepEqual(s.sent, ['settle']);
  assert.deepEqual(keys, [['/checkout/deposit/settle', [MERCHANT]]]);
  assert.deepEqual(hooks, ['order.paid:deposit', 'order.ready:deposit', 'order.finality:deposit']);
  st = await status();
  assert.deepEqual(s.sent, ['settle'], 'paid: polling never settles again');
  s.safe = 200n;
  assert.equal((await status()).stage, 'ethereum');

  const explicit = await fetch(`${base}/checkout/deposit/settle`, { method: 'POST', body: JSON.stringify({ order }) });
  assert.deepEqual([explicit.status, (await explicit.json()).code], [409, 'already-paid']);

  const refund = { id: ID, amount: '50000', refundNo: '0', validAfter: String(NOW - 10), validBefore: String(NOW + 600), signature: SIG };
  const r = await fetch(`${base}/checkout/deposit/refund`, { method: 'POST', body: JSON.stringify(refund) });
  assert.equal(r.status, 200);
  assert.equal(s.paid!.refunded, 50_000n);
  assert.equal((await (await fetch(`${base}/checkout/deposit/refund`, { method: 'POST', body: JSON.stringify({ ...refund, amount: '200000', refundNo: '1' }) })).json()).code, 'refund-too-large');
  assert.equal((await status()).status, 'partially-refunded');
  assert.ok(hooks.includes('order.refunded:deposit'));
});

test('deposit settle: refuses underpaid and expired orders; bad ?order= is 400; not configured is 503', async () => {
  const { s, chain } = fake();
  const deposit = createDeposit({ address: D, chain, now: () => NOW * 1000 });
  await assert.rejects(deposit.settle({ order }), /holds 0, the order needs 200000/);
  s.vault = 300_000n;
  await assert.rejects(deposit.settle({ order: { ...order, deadline: String(NOW - 1) } }), /deadline has passed/);
  const expired = await deposit.status({ ...JSON.parse(JSON.stringify(order)), amount: 200000n, deadline: BigInt(NOW - 1) } as never);
  assert.deepEqual([expired.status, expired.expired], ['funded', true], 'an expired funded order is not settled (the customer can returnFunds)');
  assert.equal(s.sent.length, 0);
  const ok = await deposit.settle({ order });
  assert.equal(ok.ok, true);

  const srv = createServer(createHandler({ deposit }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/checkout/deposit/status?order=nope`)).status, 400);
  assert.equal((await fetch(`${base}/checkout/deposit/status`)).status, 400);
  const off = createServer(createHandler({}));
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
  off.unref();
  assert.equal((await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/checkout/deposit/status?order=${q(order)}`)).status, 503);
});
