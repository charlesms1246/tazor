import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData, toEventSelector, toFunctionSelector, type Hex } from 'viem';
import * as sdk from '../../../packages/pay/src/checkout.ts';
import * as web from '../lib/checkout.ts';

const CHECKOUT = '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670' as const;
const MERCHANT = '0xc1dce946D192e344251972470237F1471C93876c' as const;
const PAYER = '0x00000000000000000000000000000000000a11ce' as const;

test('web checkout formulas match the SDK', () => {
  const order = { merchant: MERCHANT, amount: 1_550_000n, ref: sdk.orderRef('ORD-1001'), deadline: 1_900_000_000n };
  assert.equal(web.orderRef('ORD-1001'), order.ref);
  assert.equal(web.orderId(order, CHECKOUT, 1874), sdk.orderId(order, CHECKOUT, 1874));
  assert.equal(web.payNonce(order, CHECKOUT, 1874), sdk.payNonce(order, CHECKOUT, 1874));
  const id = sdk.orderId(order, CHECKOUT, 1874);
  assert.equal(web.refundNonce(id, 500_000n, 2), sdk.refundNonce(id, 500_000n, 2));
  assert.notEqual(web.refundNonce(id, 500_000n, 2, true), sdk.refundNonce(id, 500_000n, 2));
  const plan = { merchant: MERCHANT, amount: 2_000_000n, period: 60, cycles: 3, ref: sdk.orderRef('PLAN-1') };
  assert.equal(web.subId(plan, PAYER, CHECKOUT, 1874), sdk.subId(plan, PAYER, CHECKOUT, 1874));
  assert.equal(web.subNonce(plan, PAYER, CHECKOUT, 1874), sdk.subNonce(plan, PAYER, CHECKOUT, 1874));
});

test('web typed data hashes match the SDK', () => {
  const id = ('0x' + '11'.repeat(32)) as Hex;
  const w = { validAfter: 0n, validBefore: 1_900_000_000n };
  const a = web.refundTypedData(id, MERCHANT, 700_000n, 1, { checkout: CHECKOUT, chainId: 1874, ...w });
  const b = sdk.refundTypedData(id, MERCHANT, 700_000n, 1, { checkout: CHECKOUT, chainId: 1874, ...w });
  assert.equal(hashTypedData(a as never), hashTypedData(b as never));
  assert.equal(hashTypedData(web.cancelTypedData(id, CHECKOUT, 1874) as never), hashTypedData(sdk.cancelTypedData(id, CHECKOUT, 1874) as never));
});

test('web checkout ABI: every SDK event, and only functions the SDK also has', () => {
  const sig = (abi: readonly { type: string; name?: string }[], type: string) =>
    new Set(abi.filter((x) => x.type === type).map((x) => (type === 'event' ? toEventSelector(x as never) : toFunctionSelector(x as never)) + (x.name ?? '')));
  const webEvents = sig(web.checkoutAbi, 'event');
  for (const s of sig(sdk.checkoutAbi, 'event')) assert.ok(webEvents.has(s), `missing event ${s}`);
  const sdkFns = sig(sdk.checkoutAbi, 'function');
  for (const s of sig(web.checkoutAbi, 'function')) assert.ok(sdkFns.has(s), `function not in the SDK ${s}`);
});

test('same-block events keep chain order even when the explorer lists them newest first', async () => {
  const { depositExplorerItems, DEP_ORDER, BLUEJAY } = await import('./checkout-fixtures.ts');
  const logs = depositExplorerItems().map((it) => ({ topics: it.topics as (Hex | null)[], data: it.data, blockNumber: it.block_number, transactionHash: it.transaction_hash, logIndex: it.index, block_timestamp: it.block_timestamp }));
  const { orders } = web.merchantView(web.decodeCheckoutLogs(logs), [BLUEJAY]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, DEP_ORDER.toLowerCase());
  assert.equal(orders[0].method, 'transfer');
  assert.equal(orders[0].returned, 250_000n);
});

test('ready to ship: the web copy matches the SDK for every stage, threshold edge and policy', () => {
  const stages = [null, 'pending', 'sequencer', 'ethereum', 'finalized'] as const;
  const amounts = [0n, 1_550_000n, 99_999_999n, 100_000_000n, 100_000_001n, 5_000_000_000n, '99.99', '100', '250.5'];
  const policies = [undefined, { waitForEthereumAbove: '10' }, { waitForEthereumAbove: '100', waitForFinalAbove: '1000' }];
  for (const st of stages) for (const a of amounts) for (const p of policies) {
    assert.deepEqual(web.readyToShip(a, st, p), sdk.readyToShip(a, st, p), `${String(a)} @ ${st} ${JSON.stringify(p)}`);
  }
  assert.equal(web.readyToShip(100_000_000n, 'sequencer').ready, false, '100 USDT is inclusive: it waits');
  assert.equal(web.stageOf({ block: 10, safe: 10, finalized: 5 }), 'ethereum');
});
