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

test('inrText: indicative rupees at the static reference rate, Indian grouping, exact to the paisa', async () => {
  const { inrText, inrPaise, INR_PER_USDT, INR_RATE_NOTE } = await import('../lib/money.ts');
  assert.equal(INR_PER_USDT, 88);
  assert.equal(inrText(1_000_000n), '≈ ₹88.00');
  assert.equal(inrText(118_000_000n), '≈ ₹10,384.00');
  assert.equal(inrText(1_180_000n), '≈ ₹103.84');
  assert.equal(inrText(12_345_678_900_000n), '≈ ₹1,08,64,19,743.20'); // 12,345,678.9 USDT × 88
  assert.equal(inrText(5n), '≈ ₹0.00');
  assert.equal(inrPaise(5_682n), 50n, '0.005682 USDT = 0.4999… ₹ rounds to 50 paise');
  assert.equal(inrText(-250_000n), '≈ −₹22.00');
  assert.match(INR_RATE_NOTE, /^Indicative: 1 USDT ≈ ₹88\.00 \(static reference rate/);
});
