import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeAbiParameters, encodeFunctionResult, keccak256, stringToHex, type Address } from 'viem';
import { revocationListAbi } from '../lib/abi/RevocationList.ts';
import { decodeIsRevoked, decodeRevokeDigest, encodeRevokeDigestCall, revokeDigest, revokeRelayerBody } from '../lib/revoke.ts';

const RL: Address = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e';
const r = {
  account: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6' as Address,
  target: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as Address,
  deadline: 2000000000n,
};

test('Revoke digest equals a hand-computed EIP-712 hash', () => {
  const k = (s: string) => keccak256(stringToHex(s));
  const domainSep = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), k('Tazor'), k('1'), 1874n, RL],
  ));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [k('Revoke(address account,address target,uint256 deadline)'), r.account, r.target, r.deadline],
  ));
  const manual = keccak256(concat(['0x1901', domainSep, structHash]));
  assert.equal(revokeDigest(r, RL, 1874), manual);
  assert.notEqual(revokeDigest(r, RL, 1875), manual);
  assert.notEqual(revokeDigest({ ...r, deadline: r.deadline + 1n }, RL, 1874), manual);
  console.log('Revoke digest', manual);
});

test('revokeDigest / isRevoked call encoding round trips', () => {
  assert.ok(encodeRevokeDigestCall(r).startsWith('0x'));
  assert.equal(encodeRevokeDigestCall(r).length, 2 + 8 + 3 * 64);
  const d = `0x${'ab'.repeat(32)}` as const;
  assert.equal(decodeRevokeDigest(encodeFunctionResult({ abi: revocationListAbi, functionName: 'revokeDigest', result: d })), d);
  assert.equal(decodeIsRevoked(encodeFunctionResult({ abi: revocationListAbi, functionName: 'isRevoked', result: true })), true);
  assert.deepEqual(revokeRelayerBody(r, r.target, '0x01'), { ...r, admin: r.target, deadline: '2000000000', sig: '0x01' });
});
