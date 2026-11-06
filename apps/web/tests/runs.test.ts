import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes } from 'viem';
import { runDigest } from '../lib/runs.ts';

// Expected values read once (read-only eth_call runDigest) from the live PaymentModule v1 0xe19d…540A
// and PaymentModuleV2 0x9066…36f3 on Whitechain Sepolia.
const A = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const P = '0xc1dce946D192e344251972470237F1471C93876c';
const auths = [
  { invoiceHash: keccak256(toBytes('run vector 1')), account: A, payee: P, amount: 1_000_000n, expiry: 1_999_999_999n, nonce: 11n },
  { invoiceHash: keccak256(toBytes('run vector 2')), account: A, payee: P, amount: 2_500_000n, expiry: 1_999_999_999n, nonce: 12n },
] as const;

test('v1 runDigest equals the live PaymentModule.runDigest', () => {
  assert.equal(
    runDigest([...auths], { chainId: 1874, verifyingContract: '0xe19ddf1fd417B146137A5dE6eb56c4589431540A', version: '1' }),
    '0x07b70217b2dd080a30674499bafc6d811868a0c14f44770df30987eeebd18543',
  );
});

test('v2 runDigest equals the live PaymentModuleV2.runDigest', () => {
  assert.equal(
    runDigest([...auths], { chainId: 1874, verifyingContract: '0x906620D82e2959351c81D731C67EA46DF71E36f3', version: '2' }),
    '0x1bb25bf6720ed308c6c1188393119738050670e65098fa51794fedfb80e37b71',
  );
});

test('the run digest depends on order', () => {
  const d = { chainId: 1874, verifyingContract: '0xe19ddf1fd417B146137A5dE6eb56c4589431540A', version: '1' } as const;
  assert.notEqual(runDigest([auths[1], auths[0]], d), runDigest([...auths], d));
});
