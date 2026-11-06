import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentWithReplay, replayDeliveries } from '../src/checkout/replay.ts';
import { verify, type Delivery } from '../src/webhooks.ts';

const M = '0x27fD4E9a95cDd369A2A8a61081E376df0906E936' as const;
const rows = [
  { kind: 'paid', id: '0x' + '11'.repeat(32), tx: '0x' + 'aa'.repeat(32), block: 1n, time: 1_800_000_000, method: 'wallet', payer: '0x' + '22'.repeat(20), amount: 200_000n, ref: '0x' + '33'.repeat(32) },
  { kind: 'refunded', id: '0x' + '11'.repeat(32), tx: '0x' + 'bb'.repeat(32), block: 2n, time: 1_800_000_010, method: 'wallet', payer: '0x' + '22'.repeat(20), amount: 50_000n, totalRefunded: 50_000n },
] as never[];

test('replayed events are signed so the merchant can verify them', () => {
  const d = replayDeliveries(M, rows, 'whsec_x');
  assert.deepEqual(d.map((x) => x.type), ['order.refunded', 'order.paid']);
  for (const x of d) assert.ok(verify('whsec_x', x.rawBody, x.signature, x.created));
  assert.equal(JSON.parse(d[1].rawBody).data.amountUsdt, '0.200000');
});

test('stored deliveries win; chain fills the gaps', async () => {
  const stored = [{ id: 'x', type: 'order.paid', merchant: M.toLowerCase(), created: 1_800_000_001, txHash: '0x' + 'aa'.repeat(32), status: 'delivered', attempts: 1, data: {}, rawBody: '{}', signature: 's', explorer: null }] as Delivery[];
  const r = await recentWithReplay(M, stored, 'whsec_x', async () => rows);
  assert.equal(r.replayed, 1);
  assert.deepEqual(r.items.map((i) => i.status), ['signed', 'delivered']);
  assert.deepEqual((await recentWithReplay(M, stored, undefined, async () => rows)).items.length, 1);
});
