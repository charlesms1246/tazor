import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyFlows, sumFlows, niceMax } from '../lib/dashboard.ts';
import type { Transfer } from '../lib/activity.ts';

const t = (time: string, amount: bigint, incoming: boolean): Transfer => ({
  id: time + amount, time, amount, incoming, txHash: '0x', from: '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000002',
});

test('buckets transfers by UTC day over the window, oldest first', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const rows = dailyFlows([
    t('2026-11-06T08:00:00Z', 100000n, false), t('2026-11-06T09:00:00Z', 500000n, true),
    t('2026-11-04T01:00:00Z', 2000000n, false), t('2026-10-01T00:00:00Z', 9n, true),
  ], 3, now);
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-04', '2026-11-05', '2026-11-06']);
  assert.equal(rows[0].out, 2000000n);
  assert.equal(rows[1].in + rows[1].out, 0n);
  assert.equal(rows[2].in, 500000n);
  assert.deepEqual(sumFlows(rows), { in: 500000n, out: 2100000n });
});

test('niceMax rounds up to 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceMax(0n), 1);
  assert.equal(niceMax(2_600_000n), 5);
  assert.equal(niceMax(1_000_000n), 1);
  assert.equal(niceMax(12_000_000n), 20);
});
