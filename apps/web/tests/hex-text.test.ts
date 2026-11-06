import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasHex } from '../lib/hex-text.ts';
import { plain } from '../lib/human.ts';

test('hasHex flags raw technical values; plain() is what the UI shows instead', () => {
  const msg = `Refusing to sign: on-chain run digest 0x${'ab'.repeat(32)} does not match the invoices shown.`;
  assert.equal(hasHex(msg), true);
  assert.equal(hasHex('PaymentMissingRole(0x00aBed5bDddf794c415eE746d3E4De5332cC5450)'), true);
  assert.equal(hasHex('Relayer unreachable'), false);
  assert.equal(hasHex('nonce 42'), false);
  assert.equal(hasHex(plain(msg)), false);
});
