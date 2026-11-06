import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitCommand, admitted } from '../lib/admission.ts';

const ACCT = '0x2C09514cdd66e2b1f6d90840E5fB224b9DFcABFD';
const SIGNER = '0x' + 'ab'.repeat(84);

test('admit command is one line with only hex and a plain company id', () => {
  assert.equal(admitCommand(ACCT, SIGNER, 'acme'), `SIGNER=${SIGNER} zsh scripts/admit-approver.sh ${ACCT} acme`);
  assert.ok(!admitCommand(ACCT, SIGNER, 'bluejay').includes('\n'));
  assert.throws(() => admitCommand('0x12', SIGNER, 'acme'));
  assert.throws(() => admitCommand(ACCT, '0xzz', 'acme'));
  assert.throws(() => admitCommand(ACCT, SIGNER, 'acme; rm -rf ~'));
  assert.throws(() => admitCommand(ACCT, SIGNER, '$(id)'));
});

test('admitted only when every step is confirmed', () => {
  assert.equal(admitted({ deployed: true, verified: true, approver: true }), true);
  assert.equal(admitted({ deployed: true, verified: true, approver: null }), false);
  assert.equal(admitted({ deployed: false, verified: true, approver: true }), false);
});
