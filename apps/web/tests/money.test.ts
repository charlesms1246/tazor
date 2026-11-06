import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usdtNumber, usdtText } from '../lib/money.ts';

test('usdtNumber: two decimals, more only when non-zero; never base units', () => {
  assert.equal(usdtNumber(1_200_000n), '1.20');
  assert.equal(usdtNumber(118_000_000n), '118.00');
  assert.equal(usdtNumber(1_250_000n), '1.25');
  assert.equal(usdtNumber(0n), '0.00');
  assert.equal(usdtNumber(5n), '0.000005');
  assert.equal(usdtNumber(1_234_500n), '1.2345');
  assert.equal(usdtNumber(-250_000n), '-0.25');
  assert.equal(usdtText(2_500_000n), '2.50 USDT');
});
