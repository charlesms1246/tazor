import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { netSales, salesStats } from '../lib/checkout-stats.ts';
import type { OrderRow, SubRow } from '../lib/checkout.ts';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const D = 86_400_000;
const A = '0x00000000000000000000000000000000000000A1' as Address;
const B = '0x00000000000000000000000000000000000000b2' as Address;
const C = '0x00000000000000000000000000000000000000C3' as Address;
let n = 0;
const order = (payer: Address, amount: bigint, at: number | null, method: 'signed' | 'transfer' = 'signed', refunds: { amount: bigint; at: number | null }[] = []): OrderRow => ({
  id: `0x${(++n).toString(16).padStart(64, '0')}` as Hex, method, merchant: '0x0000000000000000000000000000000000000001', payer, amount, ref: '0x' as Hex, paidAt: at, tx: '0x' as Hex, block: n,
  refunded: refunds.reduce((s, r) => s + r.amount, 0n), refunds: refunds.map((r) => ({ ...r, tx: '0x' as Hex, to: payer })), returned: 0n,
});
const sub = (payer: Address, charges: { amount: bigint; at: number | null }[]): SubRow => ({
  id: `0x${(++n).toString(16).padStart(64, '0')}` as Hex, merchant: '0x0000000000000000000000000000000000000001', payer, amount: 50_000n, period: 86400, cycles: 3,
  charged: charges.length, cancelled: false, started: charges[0]?.at ?? null, charges: charges.map((c, i) => ({ cycle: i + 1, amount: c.amount, tx: '0x' as Hex, at: c.at })),
});

test('salesStats: gross, refunds, net, payments, average, repeat customers, refund rate, channels, 14-day series, top customers', () => {
  const view = {
    orders: [
      order(A, 1_000_000n, NOW - 2 * D, 'signed', [{ amount: 200_000n, at: NOW - D }]),
      order(A, 500_000n, NOW, 'transfer'),
      order(B, 2_000_000n, NOW - 20 * D),          // outside the 14-day window, still in totals
      order(C, 300_000n, null),                     // no timestamp yet
    ],
    subs: [sub(B, [{ amount: 50_000n, at: NOW - 2 * D }, { amount: 50_000n, at: NOW - D }])],
  };
  const s = salesStats(view, { now: NOW });
  assert.deepEqual([s.gross, s.refunds, s.net], [3_900_000n, 200_000n, 3_700_000n]);
  assert.deepEqual([s.payments, s.orders, s.charges], [6, 4, 2]);
  assert.equal(s.average, 650_000n);
  assert.deepEqual([s.customers, s.repeatCustomers], [3, 2], 'A (2 orders) and B (an order + 2 charges) are repeat customers');
  assert.equal(s.refundRate, 0.0512);
  assert.deepEqual(s.byChannel, { wallet: { count: 3, gross: 3_300_000n }, transfer: { count: 1, gross: 500_000n }, subscription: { count: 2, gross: 100_000n } });
  assert.equal(s.daily.length, 14);
  assert.deepEqual(s.daily.slice(-3), [{ day: '2026-11-05', net: 1_050_000n }, { day: '2026-11-06', net: -150_000n }, { day: '2026-11-07', net: 500_000n }]);
  assert.equal(s.daily[0].day, '2026-10-25');
  assert.deepEqual(s.topCustomers.map((c) => [c.payer, c.payments, c.net]), [[B, 3, 2_100_000n], [A, 2, 1_300_000n], [C, 1, 300_000n]]);

  const empty = salesStats({ orders: [], subs: [] }, { now: NOW });
  assert.deepEqual([empty.gross, empty.average, empty.refundRate, empty.repeatCustomers, empty.topCustomers.length], [0n, 0n, 0, 0, 0]);
});

test('netSales: payments minus refunds within a period', () => {
  const view = { orders: [order(A, 1_000_000n, NOW - 2 * D, 'signed', [{ amount: 200_000n, at: NOW - D }]), order(B, 400_000n, NOW - 40 * D)], subs: [sub(C, [{ amount: 50_000n, at: NOW }])] };
  assert.deepEqual(netSales(view, NOW - 7 * D), { gross: 1_050_000n, refunds: 200_000n, net: 850_000n, payments: 2 });
  assert.deepEqual(netSales(view, 0, NOW - 30 * D), { gross: 400_000n, refunds: 0n, net: 400_000n, payments: 1 });
});
