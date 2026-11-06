import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_ROLE_BITS, ROLE_BITS_RECORD, compareRoleBits, roleBitsText } from '../lib/role-bits.ts';
import { ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN } from '../lib/policies.ts';
import { storageState } from './directory-fixture.ts';

test('role bits: the published record matches the contract constants; differences are listed', () => {
  assert.equal(1n << BigInt(APP_ROLE_BITS.APPROVER), ROLE_APPROVER);
  assert.equal(1n << BigInt(APP_ROLE_BITS.TAZOR_ADMIN), ROLE_TAZOR_ADMIN);
  assert.equal(1n << BigInt(APP_ROLE_BITS.AGENT), ROLE_AGENT);
  assert.equal(ROLE_BITS_RECORD, '{"APPROVER":64,"TAZOR_ADMIN":68,"AGENT":72}');
  assert.deepEqual(compareRoleBits(null), { status: 'missing', diffs: [] });
  assert.deepEqual(compareRoleBits(JSON.parse(ROLE_BITS_RECORD)), { status: 'match', diffs: [] });
  assert.deepEqual(compareRoleBits({ APPROVER: 65, TAZOR_ADMIN: 68 }), { status: 'mismatch', diffs: ['APPROVER is bit 65 on ENS, 64 in the contracts', 'AGENT not published'] });
  assert.equal(roleBitsText(APP_ROLE_BITS), 'APPROVER 64 · TAZOR_ADMIN 68 · AGENT 72');
});

test('the Playwright storage state is generated from the directory fixture (regenerate if this fails)', () => {
  const file = JSON.parse(readFileSync(new URL('./ens-directory.state.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(storageState())));
});
