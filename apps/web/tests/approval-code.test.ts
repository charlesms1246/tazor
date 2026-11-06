import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalRef, encodeApprovalCode, parseApprovalInput, shareText } from '../lib/approval-code.ts';
import { serializeApproval } from '../lib/payment.ts';

const digest = '0x8f3a11c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f' as const;
const other = '0x1234567800000000000000000000000000000000000000000000000000000000' as const;
const priya = { approver: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as const, signature: `0x${'ab'.repeat(65)}${'cd'.repeat(240)}` as `0x${string}` };
const cfo = { approver: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967' as const, signature: `0x${'11'.repeat(65)}` as `0x${string}` };

test('approval codes round-trip, carry a short reference, and parse from a whole forwarded message', () => {
  const code = encodeApprovalCode(priya, digest);
  assert.match(code, /^TZA1\.8f3a11c2\.[A-Za-z0-9_-]+$/);
  assert.equal(approvalRef(digest), '8f3a11c2');
  assert.deepEqual(parseApprovalInput(code, digest), [priya]);
  const msg = `Hi, here you go.\n${shareText(priya, digest, 'INV-20261106-4F67')}\nand the CFO's: ${encodeApprovalCode(cfo, digest)} thanks`;
  assert.match(msg, /Tazor approval for INV-20261106-4F67: TZA1\./);
  assert.deepEqual(parseApprovalInput(msg, digest), [priya, cfo]);
});

test('approval input: refuses another invoice, damaged codes and noise with readable reasons; still reads the old JSON', () => {
  assert.throws(() => parseApprovalInput(encodeApprovalCode(priya, other), digest), /for a different invoice or run/);
  assert.throws(() => parseApprovalInput('TZA1.8f3a11c2.AAAAAAAAAAAAAAAAAAAAAAAAAAAA', digest), /incomplete/);
  assert.throws(() => parseApprovalInput('looks good to me', digest), /starts with TZA1/);
  assert.deepEqual(parseApprovalInput('   '), []);
  assert.deepEqual(parseApprovalInput(serializeApproval(priya)), [priya]);
  assert.deepEqual(parseApprovalInput(JSON.stringify([priya, cfo])), [priya, cfo]);
  // without a digest (unknown context) any reference is accepted
  assert.deepEqual(parseApprovalInput(encodeApprovalCode(cfo, other)), [cfo]);
});
