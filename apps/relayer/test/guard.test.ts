import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { createHandler } from '../src/app.ts';
import { DEFAULT_LIMITS, Paused, Throttled, createGuard, limitsFromEnv } from '../src/guard.ts';

const A = '0x00000000000000000000000000000000000000aa';

test('guard: per-IP hourly cap across routes, per-account daily cap per route, approver cap per IP per day', async () => {
  let t = 0;
  const g = createGuard({ limits: { perIpHour: 3, perAccountDay: 2, approverPerIpDay: 1 }, now: () => t });
  await g.check('/pay', '1.1.1.1', A);
  await g.check('/pay', '1.1.1.1', A);
  await assert.rejects(g.check('/pay', '2.2.2.2', A), (e: unknown) => e instanceof Throttled && /per account per day/.test(e.message));
  await g.check('/payrun', '1.1.1.1', A); // other route: its own account budget; this IP's 3rd this hour
  await assert.rejects(g.check('/sync', '1.1.1.1', '0x01'), (e: unknown) => e instanceof Throttled && e.retryAfterSec > 0 && /per address per hour/.test(e.message));
  t += 3_600_001;
  await g.check('/sync', '1.1.1.1', '0x01');

  await g.check('/approver', '3.3.3.3', '0xaa01');
  await assert.rejects(g.check('/approver', '3.3.3.3', '0xaa02'), /new approver accounts per address per day/);
  await g.check('/approver', '4.4.4.4', '0xaa03');
});

test('guard: pauses below the balance floor and once the day\'s spend (balance drop) reaches the budget; top-ups and a new day reset', async () => {
  let t = Date.parse('2026-11-06T10:00:00Z');
  let balance = parseEther('0.30');
  const g = createGuard({ limits: { minBalance: parseEther('0.05'), dailyBudget: parseEther('0.1') }, balance: async () => balance, now: () => t, cacheMs: 0 });
  await g.check('/pay', 'ip', A);
  balance = parseEther('0.21'); // spent 0.09
  await g.check('/pay', 'ip', A);
  balance = parseEther('0.20'); // spent 0.10 = budget
  await assert.rejects(g.check('/pay', 'ip', A), (e: unknown) => e instanceof Paused && /gas budget/.test(e.message) && /anyone can still submit/.test(e.message));
  t += 86_400_000; // next UTC day: a new baseline
  await g.check('/pay', 'ip2', A);
  balance = parseEther('0.04');
  await assert.rejects(g.check('/pay', 'ip3', A), (e: unknown) => e instanceof Paused && /low balance \(0.04 WBT, floor 0.05\)/.test(e.message));
  balance = parseEther('1'); // topped up: the baseline rises with it
  await g.check('/pay', 'ip4', A);
  const h = await g.health();
  assert.equal(h.balanceWBT, '1');
  assert.equal(h.paused, false);
});

test('guard health: balance, runway (usable balance / gas per payment), limits; env overrides', async () => {
  const g = createGuard({ balance: async () => parseEther('0.44'), gasPrice: async () => 1_000_000_000n });
  const h = await g.health();
  assert.equal(h.balanceWBT, '0.44');
  // (0.44 - 0.05 floor) / (250k gas * 1 gwei) = 1560 payments
  assert.deepEqual(h.runway, { payments: 1560, gasPerPayment: 250_000, gasPriceWei: '1000000000' });
  assert.equal(h.limits.minBalanceWBT, '0.05');
  assert.match(h.limits.note, /per server instance/);
  const l = limitsFromEnv({ RELAYER_IP_PER_HOUR: '5', RELAYER_MIN_BALANCE_WBT: '0.2', RELAYER_DAILY_BUDGET_WBT: 'junk' });
  assert.deepEqual([l.perIpHour, l.minBalance, l.dailyBudget], [5, parseEther('0.2'), DEFAULT_LIMITS.dailyBudget]);
});

test('HTTP: /approver loops are cut off with 429 + Retry-After; a low balance is 503 "relayer paused" for /pay and /payrun; /health shows gas', async () => {
  let balance = parseEther('0.44');
  const sent: Address[] = [];
  const sender = { address: zeroAddress, send: async (to: Address) => { sent.push(to); return `0x${'ab'.repeat(32)}` as Hex; } };
  let n = 0;
  const approvers = {
    factory: '0x00000000000000000000000000000000000000fa' as Address,
    webAuthnVerifier: async () => '0x0000000000000000000000000000000000000001' as Address,
    predict: async () => `0x${(++n).toString(16).padStart(40, '0')}` as Address,
    isDeployed: async () => false,
    createCalldata: () => '0x1234' as Hex,
  };
  const guard = createGuard({ limits: { approverPerIpDay: 2 }, balance: async () => balance, gasPrice: async () => 1_000_000_000n, cacheMs: 0 });
  const s = createServer(createHandler({ sender: sender as never, approvers: approvers as never, guard, client: {} as never, paymentModule: '0x0000000000000000000000000000000000007000' }));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify(body) });

  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post('/approver', { signer: `0x${(0xf00 + i).toString(16).padStart(40, '0')}` })).status);
  assert.deepEqual(codes, [200, 200, 429, 429]);
  assert.equal(sent.length, 2);
  const limited = await post('/approver', { signer: `0x${'cd'.repeat(20)}` });
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  balance = parseEther('0.01');
  const pay = { account: A, auth: { invoiceHash: `0x${'aa'.repeat(32)}`, account: A, payee: '0x0000000000000000000000000000000000000003', amount: '1', expiry: '2000000000', nonce: '7' }, approvers: ['0x00000000000000000000000000000000000a11ce'], signatures: ['0xaa01'] };
  const r = await post('/pay', pay);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.paused, true);
  assert.match(j.error, /^relayer paused: low balance .*anyone can still submit/);
  const run = await post('/payrun', { account: A, auths: [pay.auth], approvers: pay.approvers, signatures: pay.signatures });
  assert.equal(run.status, 503);
  assert.match((await run.json()).error, /^relayer paused: low balance/);
  assert.equal((await post('/pay/calldata', pay)).status, 200, 'calldata is free and never paused');
  assert.equal(sent.length, 2);

  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.gas.balanceWBT, '0.01');
  assert.equal(h.gas.paused, true);
  assert.equal(h.gas.runway.payments, 0);
  s.close();
});
