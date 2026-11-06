import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../lib/friendly-errors.ts';

const ctx = { company: 'Acme Industries', supplier: 'Bluejay Logistics' };

test('friendlyError: contract reverts and device errors become a plain sentence with the fix', () => {
  const missing = friendlyError('simulation reverted: PaymentMissingRole(0x00aBed5bDddf794c415eE746d3E4De5332cC5450)', ctx)!;
  assert.equal(missing.title, "Your passkey account isn't an approver for Acme Industries yet.");
  assert.match(missing.fix, /join command shown on Approver setup/);
  assert.equal(missing.href, '/onboard/');
  assert.equal(friendlyError('No passkey on this device. Create one on the onboarding page first.')!.href, '/onboard/');
  assert.match(friendlyError('NotAllowedError: The operation either timed out or was not allowed.')!.title, /passkey prompt was cancelled or timed out/);
  assert.match(friendlyError('Relayer unreachable: use "Send via Ethereum" below, or "Copy calldata".')!.fix, /Send via Ethereum/);
  assert.match(friendlyError('simulation reverted: PaymentPayeeNotAllowed(0xc1dc…)', ctx)!.title, /Acme Industries hasn't approved Bluejay Logistics as a payee/);
  assert.match(friendlyError('simulation reverted: PaymentStaleRoles(0x1, 5, 9)')!.fix, /Sync the roles/);
  assert.match(friendlyError('ERC20InsufficientBalance(0xb99a…, 1, 2)', ctx)!.title, /Acme Industries's account doesn't hold enough USDT/);
  assert.match(friendlyError('simulation reverted: PaymentExpired(7)', ctx)!.fix, /Ask Bluejay Logistics for a new payment link/);
  assert.match(friendlyError('PaymentNotEnoughApprovers(2, 1)')!.title, /needs another approval/);
  assert.match(friendlyError('account 0xb99a has no PaymentModule configuration', ctx)!.title, /can't submit payments for Acme Industries/);
  assert.equal(friendlyError('something nobody planned for'), null);
  assert.match(friendlyError('PaymentMissingRole(0x1)')!.title, /for your company yet/, 'context defaults');
});
