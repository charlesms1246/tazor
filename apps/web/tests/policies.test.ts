import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes } from 'viem';
import { invoiceAuthDigestV2, policyDigest, policyStructHash, ROLE_APPROVER, type PolicyMessage } from '../lib/policies.ts';

// Expected values read once (read-only eth_call) from the live Whitechain Sepolia contracts:
// PaymentModuleV2 0x9066…36f3 typedDigest(structHash) / invoiceDigest.
const PM2 = '0x906620D82e2959351c81D731C67EA46DF71E36f3';
const d = { chainId: 1874, verifyingContract: PM2 } as const;
const ACCOUNT = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c';
const MEERA = '0x03C291d446b870e0B8F128681937a9eCEDa97763';
const PRIYA = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const DEADLINE = 2_000_000_000n;
const IH = keccak256(toBytes('tazor web vector'));

const vectors: [PolicyMessage, string][] = [
  [{ type: 'AddPayee', message: { account: ACCOUNT, payee: PAYEE, deadline: DEADLINE } },
    '0x61a88055c24d8e6f8fcf7269352d246944ca99263614a28e5cf087f1af5f3373'],
  [{ type: 'ProvisionalGrant', message: { account: ACCOUNT, grantee: MEERA, roles: ROLE_APPROVER, validUntil: 1_999_999_999n, deadline: DEADLINE } },
    '0x465938d37da0525a14b341706e59feadcc1e2782b1186536b67ce4db15dbb88d'],
  [{ type: 'ApproverExpiry', message: { account: ACCOUNT, approver: PRIYA, until: 1_999_999_999n, deadline: DEADLINE } },
    '0x6e9a65392aed761051493151f6d50879a2f1830bd4c00e8e6ee408bef3f0203d'],
  [{ type: 'RequestExit', message: { account: ACCOUNT, exitIndex: 0n, deadline: DEADLINE } },
    '0x4f2f8b45d9c803cf5388c1249b724cefd0cdefb1b1a9f326768d226db92716fc'],
  [{ type: 'CancelExit', message: { account: ACCOUNT, deadline: DEADLINE } },
    '0xbeb47b71c7cf1f3bd50ab51f224663211eff4f2ca47325bb062fb6d280d344ff'],
];

for (const [m, expected] of vectors) {
  test(`${m.type} digest equals the live PaymentModuleV2.typedDigest`, () => {
    assert.equal(policyDigest(m, d), expected);
  });
}

test('struct hashes use the live typehashes (AddPayee)', () => {
  // keccak256(abi.encode(ADD_PAYEE_TYPEHASH, ...)); typehash read from the contract
  assert.equal(
    keccak256(toBytes('AddPayee(address account,address payee,uint256 deadline)')),
    '0x441343dd7fb3d2adb6e68a0e5bb2989558f414c877101de036c1479dfe9fdfa2',
  );
  assert.match(policyStructHash(vectors[0][0]), /^0x[0-9a-f]{64}$/);
});

test('v2 invoice digest equals the live PaymentModuleV2.invoiceDigest (domain version 2)', () => {
  const auth = { invoiceHash: IH, account: ACCOUNT, payee: PAYEE, amount: 1_200_000n, expiry: 1_999_999_999n, nonce: 7n } as const;
  assert.equal(invoiceAuthDigestV2(auth, d), '0xc5ba4b4002cbafdc421062f97ddcdc023faf569c97e14ca2c2f09dce1a02a622');
});
