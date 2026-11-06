import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, shortAddress, usdtText } from '../lib/human.ts';
import { friendlyError } from '../lib/friendly-errors.ts';
import { explain } from '../app/_autopilot/explain.ts';

const ADDR = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const TX = `0x${'ab'.repeat(32)}`;

test('plain: no hashes, short addresses (or names), no huge integers, no calldata', () => {
  assert.equal(shortAddress(ADDR), '0x00aB…5450');
  assert.equal(plain(`Paid 0.20 USDT tx=${TX}`), 'Paid 0.20 USDT tx=');
  assert.equal(plain(`Mandate created: ${TX}`), 'Mandate created');
  assert.equal(plain(`the relayer address ${ADDR} is not an APPROVER admin`), 'the relayer address 0x00aB…5450 is not an APPROVER admin');
  assert.equal(plain(`approved by ${ADDR}`, { [ADDR.toLowerCase()]: 'Priya' }), 'approved by Priya');
  assert.equal(plain('nonce 101846161612303385738216022315296537599886265725889234370977274778012713048670 used'), 'nonce a reference number used');
  assert.equal(plain(`calldata 0x${'12'.repeat(100)} sent`), 'calldata (data) sent');
  assert.equal(plain('INV-0042 paid in 3.6 s'), 'INV-0042 paid in 3.6 s');
  assert.equal(usdtText(200_000n), '0.20 USDT');
  assert.equal(usdtText('1.5'), '1.50 USDT');
  assert.equal(usdtText(5n), '0.000005 USDT', 'more decimals only when non-zero');
  assert.equal(usdtText(118_000_000n), '118.00 USDT');
  assert.equal(usdtText(123_456_789_012_345_678n), '123456789012.345678 USDT', 'exact for large values');
  assert.equal(usdtText('0.000005'), '0.000005 USDT');
  assert.equal(usdtText('not a number'), '0.00 USDT');
});

test('friendly errors: the Autopilot cases read as a sentence with a fix', () => {
  assert.match(friendlyError(`simulation reverted: PaymentMissingRole(${ADDR})`)!.title, /isn't an approver/);
  assert.match(friendlyError('simulation reverted: PaymentNotVerified(0x1)')!.title, /WhiteBIT-verified/);
  assert.equal(friendlyError('simulation reverted: Execution reverted for an unknown reason.')!.title, 'The contract refused this transaction.');
  assert.match(friendlyError('TypeError: Failed to fetch')!.fix, /Retry/);
  assert.match(friendlyError('Too many new guests right now; try again in 10 min')!.fix, /Retry/);
  assert.equal(friendlyError('Relayer URL is not configured')!.href, '/security/');
});

test('explain: timeouts say what was awaited; unknown errors are cleaned; known ones are friendly', () => {
  const t = explain('Timed out waiting for the "Pay" button to be ready on this page.');
  assert.equal(t.title, 'Timed out waiting for the "Pay" button to be ready on this page.');
  assert.match(t.fix, /Retry.*Skip/);
  assert.equal(explain(`weird failure at ${ADDR} ${TX}`).title, 'weird failure at 0x00aB…5450');
  assert.match(explain('simulation reverted: PaymentMissingRole(0x1)').title, /approver/);
  assert.equal(explain(TX).title, 'Something went wrong in this step.');
});
