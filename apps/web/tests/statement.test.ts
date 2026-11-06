import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transfer } from '../lib/activity.ts';
import { counterpartyOf, directionOf, signedAmount, toStatementCsv } from '../lib/statement.ts';

const ME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';
const received: Transfer = { id: 'a:0', time: '2026-11-07T08:00:00.000000Z', from: BLUEJAY, to: ME, amount: 1_500_000n, txHash: `0x${'aa'.repeat(32)}`, incoming: true };
const paid: Transfer = { id: 'b:1', time: '2026-11-07T09:30:00.000000Z', from: ME, to: BLUEJAY, amount: 254_999n, txHash: `0x${'bb'.repeat(32)}`, incoming: false };

test('direction, counterparty and sign follow the account side', () => {
  assert.equal(directionOf(received), 'Received');
  assert.equal(directionOf(paid), 'Paid');
  assert.equal(counterpartyOf(received), BLUEJAY);
  assert.equal(counterpartyOf(paid), BLUEJAY);
  assert.equal(signedAmount(received), 1_500_000n);
  assert.equal(signedAmount(paid), -254_999n);
});

test('golden statement CSV: ISO date, address, direction, signed 2 dp amount, tx hash', () => {
  assert.equal(toStatementCsv([received, paid]),
    'Date,Counterparty,Direction,Amount (USDT),Tx hash\r\n' +
    `2026-11-07T08:00:00.000000Z,${BLUEJAY},Received,1.50,0x${'aa'.repeat(32)}\r\n` +
    `2026-11-07T09:30:00.000000Z,${BLUEJAY},Paid,-0.25,0x${'bb'.repeat(32)}\r\n`);
  assert.equal(toStatementCsv([]), 'Date,Counterparty,Direction,Amount (USDT),Tx hash\r\n');
});
