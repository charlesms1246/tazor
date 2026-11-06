import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revokeDigest } from '../lib/revoke.ts';

// Expected value read once (read-only eth_call revokeDigest) from the live RevocationListV2 0x4AD5…2f5a,
// whose EIP-712 domain is ("Tazor", "1"): a self-revoke has target == admin == the device's approver.
test('self-revoke digest for RevocationListV2 equals the live revokeDigest', () => {
  const r = { account: '0xb99A12652BEe98429ae31EA0529A0b63f1073721', target: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', deadline: 2_000_000_000n } as const;
  assert.equal(revokeDigest(r, '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a', 1874), '0xb7af0a12dd392f0a98539f1149b82e499822ef5bd5865a669a4d15a791e690b8');
});
