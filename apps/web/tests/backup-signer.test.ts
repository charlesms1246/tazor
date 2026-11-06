import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { backupProofMessage } from '../lib/backup-signer.ts';

test('backup key proof: a readable message naming both accounts, verifiable for the signing wallet only', async () => {
  const w = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const approver = '0x2C09514cdd66e2b1f6d90840E5fB224b9DFcABFD';
  const m = backupProofMessage(approver, w.address.toLowerCase(), new Date('2026-11-06T18:00:00Z'));
  assert.match(m, new RegExp(`use ${w.address} as the backup key of approver account ${approver}`));
  assert.match(m, /costs nothing and sends no transaction/);
  const sig = await w.signMessage({ message: m });
  assert.equal(await verifyMessage({ address: w.address, message: m, signature: sig }), true);
  assert.equal(await verifyMessage({ address: other.address, message: m, signature: sig }), false);
});
