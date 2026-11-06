import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, hashTypedData, keccak256, recoverTypedDataAddress, stringToBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  cancelTypedData, checkoutAbi, decodeCheckoutLogs, finalityStage, merchantView, nextCharge, orderId, orderRef, payNonce, refundNonce,
  refundTypedData, subId, USDT,
} from '../lib/checkout.ts';

const CHECKOUT = '0x00000000000000000000000000000000c0ffee01' as const;
const MERCHANT = '0xc1dce946D192e344251972470237F1471C93876c' as const;
const PAYER = '0x00000000000000000000000000000000000a11ce' as const;

test('formulas follow the contract: orderId, payNonce, refundNonce, subId', () => {
  const ref = orderRef('BJ-1042');
  assert.equal(ref, keccak256(stringToBytes('BJ-1042')));
  const order = { merchant: MERCHANT, amount: 1_550_000n, ref, deadline: 2_000_000_000n };
  const id = orderId(order, CHECKOUT, 1874);
  assert.equal(id, keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [1874n, CHECKOUT, MERCHANT, ref])));
  assert.notEqual(orderId(order, CHECKOUT, 1875), id, 'chain-bound');
  assert.equal(orderId({ ...order, amount: 1n }, CHECKOUT, 1874), id, 'the id is merchant + ref only (amount is bound by the pay nonce)');
  const n = payNonce(order, CHECKOUT, 1874);
  assert.equal(n, keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }], [keccak256(stringToBytes('tazor.checkout.pay')), id, 1_550_000n, 2_000_000_000n])));
  assert.notEqual(refundNonce(id, 500_000n, 0n), refundNonce(id, 500_000n, 1n), 'each refund gets a fresh nonce');
  const plan = { merchant: MERCHANT, amount: 1_000_000n, period: 2_592_000, cycles: 12, ref };
  assert.notEqual(subId(plan, PAYER, CHECKOUT, 1874), subId({ ...plan, amount: 2_000_000n }, PAYER, CHECKOUT, 1874), 'terms are part of the id');
});

test('the refund and cancel typed data are signable and recover to the signer', async () => {
  const merchant = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const id = orderId({ merchant: merchant.address, amount: 0n, ref: orderRef('X-1'), deadline: 0n }, CHECKOUT, 1874);
  const td = refundTypedData(id, merchant.address, 250_000n, 1n, { checkout: CHECKOUT, validAfter: 0n, validBefore: 2_000_000_000n });
  assert.equal(td.domain.verifyingContract?.toLowerCase(), USDT.toLowerCase());
  assert.equal(td.domain.name, 'Tether USD');
  assert.equal(td.message.nonce, refundNonce(id, 250_000n, 1n));
  assert.equal((td.message.to as string).toLowerCase(), CHECKOUT, 'the refund is received by the checkout contract');
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== 'EIP712Domain')) as never;
  const sig = await merchant.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message } as never);
  assert.equal(await recoverTypedDataAddress({ domain: td.domain, types, primaryType: td.primaryType, message: td.message, signature: sig } as never), merchant.address);
  const c = cancelTypedData(id, CHECKOUT, 1874);
  const ctypes = Object.fromEntries(Object.entries(c.types).filter(([k]) => k !== 'EIP712Domain')) as never;
  assert.match(hashTypedData({ domain: c.domain, types: ctypes, primaryType: c.primaryType, message: c.message } as never), /^0x[0-9a-f]{64}$/);
});

const log = (eventName: string, args: Record<string, unknown>, data: Hex, block: number, tx: string, at?: string) => ({
  topics: encodeEventTopics({ abi: checkoutAbi, eventName: eventName as never, args: args as never }) as Hex[],
  data, blockNumber: block, transactionHash: tx as Hex, block_timestamp: at,
});

test('logs → orders with refunds, subscriptions with charges and cancellation; next charge; finality stages', () => {
  const id = orderId({ merchant: MERCHANT, amount: 0n, ref: orderRef('A'), deadline: 0n }, CHECKOUT, 1874);
  const sid = `0x${'5a'.repeat(32)}` as Hex;
  const other = '0x000000000000000000000000000000000000b0b0' as const;
  const logs = [
    log('OrderPaid', { id, merchant: MERCHANT, payer: PAYER }, encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [1_550_000n, orderRef('A')]), 10, '0x01', '2026-11-06T20:00:00Z'),
    log('Refunded', { id, merchant: MERCHANT, payer: PAYER }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [500_000n, 500_000n]), 12, '0x02', '2026-11-06T20:05:00Z'),
    log('OrderPaid', { id: `0x${'99'.repeat(32)}`, merchant: other, payer: PAYER }, encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [1n, orderRef('B')]), 13, '0x03'),
    log('Subscribed', { id: sid, merchant: MERCHANT, payer: PAYER }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint32' }, { type: 'uint16' }, { type: 'bytes32' }], [1_000_000n, 60, 3, orderRef('S')]), 14, '0x04', '2026-11-06T20:00:00Z'),
    log('Charged', { id: sid }, encodeAbiParameters([{ type: 'uint16' }, { type: 'uint256' }], [1, 1_000_000n]), 14, '0x04', '2026-11-06T20:00:00Z'),
    { topics: [`0x${'ee'.repeat(32)}`] as Hex[], data: '0x' as Hex, blockNumber: 15, transactionHash: '0x05' as Hex },
  ];
  const events = decodeCheckoutLogs(logs);
  assert.equal(events.length, 5, 'the unknown log is skipped');
  const { orders, subs } = merchantView(events, [MERCHANT]);
  assert.equal(orders.length, 1, "another merchant's order is not shown");
  assert.deepEqual([orders[0].amount, orders[0].refunded, orders[0].refunds.length], [1_550_000n, 500_000n, 1]);
  assert.equal(orders[0].paidAt, Date.parse('2026-11-06T20:00:00Z'));
  assert.equal(subs[0].charged, 1);
  assert.equal(nextCharge(subs[0]), Date.parse('2026-11-06T20:00:00Z') + 60_000);
  const cancelled = merchantView(decodeCheckoutLogs([...logs, log('Cancelled', { id: sid }, encodeAbiParameters([{ type: 'address' }], [PAYER]), 16, '0x06')]), [MERCHANT]);
  assert.equal(cancelled.subs[0].cancelled, true);
  assert.equal(nextCharge(cancelled.subs[0]), null);
  assert.equal(finalityStage({ block: 10, safe: 9, finalized: 5 }), 1);
  assert.equal(finalityStage({ block: 10, safe: 10, finalized: 5 }), 2);
  assert.equal(finalityStage({ block: 10, safe: 20, finalized: 10 }), 3);
  assert.equal(finalityStage({ block: 10, safe: null, finalized: null }), 1);
});
