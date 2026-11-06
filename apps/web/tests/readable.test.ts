import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayText, periodText, shortAddress, shortRef, usdtText } from '../lib/readable.ts';

test('readable: short refs, USDT amounts, periods, days, short addresses', () => {
  assert.equal(shortRef('0xA1B2C3d4e5f60000000000000000000000000000000000000000000000000000'), '#a1b2c3');
  assert.equal(shortRef(29994305890160799064562750594702642296243117310426787175449127047543479316328n), shortRef('29994305890160799064562750594702642296243117310426787175449127047543479316328'));
  assert.equal(usdtText(300_000n), '0.30 USDT');
  assert.equal(usdtText(1_000_000n), '1.00 USDT');
  assert.equal(usdtText(1_234_500n), '1.2345 USDT', 'exact: 2 decimals, more only when non-zero');
  assert.equal(periodText(2_592_000n), '30 days');
  assert.equal(periodText(86_400), '1 day');
  assert.equal(dayText(Date.parse('2026-11-13T12:00:00Z') / 1000, Date.parse('2026-11-06T00:00:00Z')), '13 Nov');
  assert.equal(dayText(Date.parse('2027-01-02T12:00:00Z') / 1000, Date.parse('2026-11-06T00:00:00Z')), '2 Jan 2027');
  assert.equal(shortAddress('0xb99A12652BEe98429ae31EA0529A0b63f1073721'), '0xb99A…3721');
});
