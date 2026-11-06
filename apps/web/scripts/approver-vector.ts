import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeBackupApproval, encodePasskeyApproval, encodePasskeySignature, passkeySigner, type WebAuthnAssertion } from '../lib/approver-signature.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const VERIFIER_PLACEHOLDER = '0x7913791379137913791379137913791379137913';
const BACKUP_KEY = keccak256(stringToHex('tazor approver-sig vector backup key'));

const wa = JSON.parse(readFileSync(join(FIXTURES, 'webauthn.json'), 'utf8'));
const passkey = (wa.assertions as (WebAuthnAssertion & { challenge: Hex })[]).map((a) => ({
  digest: a.challenge,
  signature: encodePasskeySignature(a),
  approval: encodePasskeyApproval(VERIFIER_PLACEHOLDER, wa.x, wa.y, a),
}));

const eoa = privateKeyToAccount(BACKUP_KEY);
const backupDigest = wa.assertions[0].challenge as Hex;
const sig65 = await eoa.sign({ hash: backupDigest });
const backup = { eoa: eoa.address, key: BACKUP_KEY, digest: backupDigest, signature: sig65, approval: encodeBackupApproval(eoa.address, sig65) };

const out = { verifierPlaceholder: VERIFIER_PLACEHOLDER, x: wa.x, y: wa.y, signer: passkeySigner(VERIFIER_PLACEHOLDER, wa.x, wa.y), passkey, backup };
writeFileSync(join(FIXTURES, 'approver-sig.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote approver-sig.json: ${passkey.length} passkey approvals (${passkey.map((p: { approval: Hex }) => (p.approval.length - 2) / 2).join(', ')} bytes), backup ${(backup.approval.length - 2) / 2} bytes`);
