import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeEventTopics, encodeFunctionResult, encodeAbiParameters, keccak256, stringToBytes, toFunctionSelector, toHex, type Address, type Hex } from 'viem';
import { checkoutAbi, depositAbi, type RawLog } from '../lib/checkout.ts';
import { customerHistory } from '../lib/customer.ts';
import { merchantTrust } from '../lib/merchant-trust.ts';
import { refundAmountError, refundDeepLink, refundRequestMessage } from '../lib/refund-request.ts';
import * as F from './checkout-fixtures.ts';

const CO = F.CHECKOUT as Address;
const DEP = F.DEPOSIT as Address;
const ALL = [...checkoutAbi, ...depositAbi];
const rawOf = (e: { eventName: string; args: Record<string, unknown>; data: Hex; block: number; tx: Hex }, address: string, i: number): RawLog & { address: string } =>
  ({ address, topics: encodeEventTopics({ abi: ALL, eventName: e.eventName as never, args: e.args as never }) as Hex[], data: e.data, blockNumber: toHex(e.block), transactionHash: e.tx, logIndex: toHex(i) });
const checkoutLogs = F.events.map((e, i) => rawOf(e, CO, i));
const depositLogs = F.depositEvents.map((e, i) => rawOf(e, DEP, i));
const matches = (l: RawLog, topics: (Hex | null)[]) => topics.every((t, i) => t === null || (l.topics[i] ?? '').toLowerCase() === t.toLowerCase());

const START = 1_794_002_400n;
function fakeCall(to: Address, data: Hex): Promise<Hex> {
  const abi = to.toLowerCase() === DEP.toLowerCase() ? depositAbi : checkoutAbi;
  const { functionName, args } = decodeFunctionData({ abi, data }) as { functionName: string; args: readonly unknown[] };
  if (abi === depositAbi && functionName === 'payment') return Promise.resolve(args[0] === F.DEP_ORDER ? F.depositPaymentResult() : `0x${'00'.repeat(192)}` as Hex);
  if (functionName === 'payment' && args[0] === F.ORDER) return Promise.resolve(F.paymentResult());
  if (functionName === 'payment') return Promise.resolve(encodeFunctionResult({ abi: checkoutAbi, functionName: 'payment', result: [F.OTHER, F.PAYER, 9_000_000n, 0n, 1_794_003_600n, 0] as never }));
  if (functionName === 'subscription') return Promise.resolve(encodeFunctionResult({ abi: checkoutAbi, functionName: 'subscription', result: [F.BLUEJAY, F.PAYER, 1_000_000n, 60, 3, 1, START, true] as never }));
  if (functionName === 'nextChargeAt') return Promise.resolve(encodeFunctionResult({ abi: checkoutAbi, functionName: 'nextChargeAt', result: START + 60n }));
  throw new Error(`unexpected ${functionName}`);
}
const deps = {
  call: fakeCall, checkout: CO, deposit: DEP, time: async (b: number) => b * 1000,
  logs: async (c: Address, topics: (Hex | null)[]) => (c === CO ? checkoutLogs : depositLogs).filter((l) => matches(l, topics)),
  explorer: async () => depositLogs.filter((l) => matches(l, [encodeEventTopics({ abi: depositAbi, eventName: 'DepositPaid' })[0] as Hex])),
};

test('a customer sees their signed payments with refunds, and their subscriptions with the next charge', async () => {
  const h = await customerHistory(F.PAYER as Address, deps);
  // the same payer paid two businesses: both show, newest first
  assert.deepEqual(h.orders.map((o) => [o.merchant, o.method, o.amount, o.refunded, o.net, o.refunds.length]), [
    [F.OTHER, 'signed', 9_000_000n, 0n, 9_000_000n, 0],
    [F.BLUEJAY, 'signed', 1_550_000n, 500_000n, 1_050_000n, 1],
  ]);
  assert.equal(h.orders[1].id, F.ORDER.toLowerCase());
  assert.equal(h.orders[1].paidAt, 1_794_002_400_000);
  assert.deepEqual(h.totals, { paid: 10_550_000n, refunded: 500_000n, net: 10_050_000n });
  assert.equal(h.subs.length, 1);
  assert.deepEqual([h.subs[0].charged, h.subs[0].cycles, h.subs[0].active, h.subs[0].nextAt], [1, 3, true, Number(START + 60n) * 1000]);
});

test('a payment from an exchange belongs to its refund address; strangers see nothing', async () => {
  const h = await customerHistory(F.REFUND_TO as Address, deps);
  assert.deepEqual(h.orders.map((o) => [o.id, o.method, o.amount, o.merchant]), [[F.DEP_ORDER.toLowerCase(), 'transfer', 2_000_000n, F.BLUEJAY]]);
  const none = await customerHistory('0x000000000000000000000000000000000000dEaD', deps);
  assert.equal(none.orders.length + none.subs.length, 0);
});

test('merchant trust: verified directly, through a company admin, or not; unknown when the mirror is unreachable', async () => {
  const MIRROR = '0x9822650A99bD33F29E383345F570dAE1e4E00928' as Address;
  const PM = '0x00000000000000000000000000000000000000Aa' as Address;
  const VERIFIED_PERSON = '0x00000000000000000000000000000000000000B1' as Address;
  const COMPANY = '0x00000000000000000000000000000000000000C1' as Address;
  const sel = (s: string) => toFunctionSelector(s);
  const word = (v: bigint | string) => encodeAbiParameters([{ type: typeof v === 'bigint' ? 'uint256' : 'address' }], [v as never]);
  const call = async (to: Address, data: Hex): Promise<Hex> => {
    const s = data.slice(0, 10);
    if (to === MIRROR && s === sel('soulOf(address)')) return word(data.toLowerCase().endsWith(VERIFIED_PERSON.slice(2).toLowerCase()) ? 7n : 0n);
    if (to === MIRROR && s === sel('soulAttributeValue(uint256,address)')) return `0x${'00'.repeat(19)}01${'00'.repeat(12)}` as Hex;
    if (to === PM && s === sel('registryOf(address)')) return word(data.toLowerCase().endsWith(COMPANY.slice(2).toLowerCase()) ? '0x00000000000000000000000000000000000000D1' : '0x0000000000000000000000000000000000000000');
    if (to === COMPANY && s === sel('getSigners(uint64,uint64)')) return encodeAbiParameters([{ type: 'bytes[]' }], [[VERIFIED_PERSON]]);
    throw new Error('revert');
  };
  assert.deepEqual(await merchantTrust(VERIFIED_PERSON, { mirror: MIRROR, paymentModule: PM, call }), { verified: true, via: 'business' });
  assert.deepEqual(await merchantTrust(COMPANY, { mirror: MIRROR, paymentModule: PM, call }), { verified: true, via: 'company-admin' });
  assert.deepEqual(await merchantTrust('0x00000000000000000000000000000000000000e1', { mirror: MIRROR, paymentModule: PM, call }), { verified: false });
  assert.deepEqual(await merchantTrust(VERIFIED_PERSON, { mirror: MIRROR, call: async () => { throw new Error('down'); } }), { verified: null });
});

test('refund request: the amount is optional and capped; the message carries order, amount, reason and the one-click link', () => {
  assert.equal(refundAmountError('', 1.05), null);
  assert.equal(refundAmountError('0.50', 1.05), null);
  assert.match(refundAmountError('2', 1.05) ?? '', /At most 1\.05 USDT/);
  assert.match(refundAmountError('abc', 1.05) ?? '', /amount like/);
  const link = refundDeepLink('https://tazor.charlesms.dev', F.BLUEJAY.toLowerCase(), F.ORDER, '0.50');
  assert.equal(link, `https://tazor.charlesms.dev/checkout/?merchant=${F.BLUEJAY}&tab=orders&order=${F.ORDER.toLowerCase()}&refund=0.50`);
  const m = refundRequestMessage({ business: 'Bluejay Logistics', order: 'BJ-77', paid: '1.55', paidOn: '6 Nov 2026', amount: '', reason: 'One box arrived damaged', deepLink: link, receipt: 'https://x/receipt/?order=1' });
  assert.match(m.body, /refund for order BJ-77, paid 1\.55 USDT on 6 Nov 2026/);
  assert.match(m.body, /Amount: the full amount \(1\.55 USDT\)/);
  assert.match(m.body, /Reason: One box arrived damaged/);
  assert.ok(m.body.includes(link));
  assert.equal(m.subject, 'Refund request: order BJ-77');
  void keccak256(stringToBytes('x'));
});
