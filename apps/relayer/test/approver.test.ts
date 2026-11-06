import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, type Address } from 'viem';
import { parseSigner } from '../src/approver.ts';

const VERIFIER: Address = '0x111C0a633FBca15fD0D3004233bEB91FafcEc0E3';
const X = '0x5c324e72c96949335cb63308f0749970b0ae7d88c3e2401b462197f866a92657';
const Y = '0xa760695d6d1b2abfeaca93df16a38ca558b49014a4e6f2711c067ef7570ef126';

test('accepts an 84-byte passkey id for the factory verifier (any case) and a 20-byte EOA', () => {
  const passkey = concat([VERIFIER, X, Y]);
  assert.equal(parseSigner({ signer: passkey }, VERIFIER), passkey);
  assert.equal(parseSigner({ signer: passkey.toLowerCase() }, VERIFIER), passkey.toLowerCase());
  const eoa = '0x000000000000000000000000000000000000b0b0';
  assert.equal(parseSigner({ signer: eoa }, VERIFIER), eoa);
});

test('rejects a passkey id for another verifier, wrong lengths and non-hex', () => {
  const other = concat(['0x0000000000000000000000000000000000000bad', X, Y]);
  for (const signer of [other, concat([VERIFIER, X]), '0x1234', '0x', 'abc', '0x0g' + '00'.repeat(19), 42, undefined]) {
    assert.throws(() => parseSigner({ signer }, VERIFIER), /signer/, String(signer));
  }
  assert.throws(() => parseSigner(null, VERIFIER), /signer/);
});
