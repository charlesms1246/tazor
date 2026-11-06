import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeAbiParameters, keccak256, toBytes } from 'viem';
import { ERC6492_MAGIC, createAccountCalldata, isWrapped6492, unwrap6492, wrap6492 } from '../lib/erc6492.ts';

const FACTORY = '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e';
const SIGNER = '0x111c0a633fbca15fd0d3004233beb91fafcec0e35c324e72c96949335cb63308f0749970b0ae7d88c3e2401b462197f866a92657a760695d6d1b2abfeaca93df16a38ca558b49014a4e6f2711c067ef7570ef126' as const;
const INNER = encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[SIGNER], [`0x${'ab'.repeat(65)}` as const]]);

test('wrap = abi.encode(factory, createAccount([signer]), inner) ++ magic', () => {
  const calldata = createAccountCalldata([SIGNER]);
  assert.equal(calldata.slice(0, 10), '0x' + keccak256(toBytes('createAccount(bytes[])')).slice(2, 10));
  const wrapped = wrap6492(FACTORY, calldata, INNER);
  const expected = concat([
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }], [FACTORY, calldata, INNER]),
    ERC6492_MAGIC,
  ]);
  assert.equal(wrapped, expected);
  assert.ok(wrapped.endsWith(ERC6492_MAGIC.slice(2)));
  assert.equal(ERC6492_MAGIC, '0x' + '6492'.repeat(16));
});

test('unwrap returns the factory, its calldata and the inner signature', () => {
  const calldata = createAccountCalldata([SIGNER]);
  const u = unwrap6492(wrap6492(FACTORY, calldata, INNER));
  assert.equal(u.inner.toLowerCase(), INNER.toLowerCase());
  assert.equal(u.factory?.toLowerCase(), FACTORY.toLowerCase());
  assert.equal(u.factoryCalldata, calldata);
});

test('plain signatures are not treated as wrapped', () => {
  assert.equal(isWrapped6492(INNER), false);
  assert.deepEqual(unwrap6492(INNER), { inner: INNER });
  assert.equal(isWrapped6492(wrap6492(FACTORY, createAccountCalldata([SIGNER]), INNER)), true);
});
