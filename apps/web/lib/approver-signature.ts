import { encodeAbiParameters, encodePacked, hexToBytes, type Address, type Hex } from 'viem';
import { P256_N, signChallenge } from './webauthn.ts';

export type WebAuthnAssertion = {
  r: Hex;
  s: Hex;
  challengeIndex: number | bigint;
  typeIndex: number | bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

export const passkeySigner = (verifier: Address, x: Hex, y: Hex): Hex =>
  encodePacked(['address', 'bytes32', 'bytes32'], [verifier, x, y]);

export const backupSigner = (eoa: Address): Hex => encodePacked(['address'], [eoa]);

export function encodePasskeySignature(a: WebAuthnAssertion): Hex {
  if (BigInt(a.s) > P256_N / 2n) throw new Error('passkey signature must be low-s');
  return encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'string' }],
    [a.r, a.s, BigInt(a.challengeIndex), BigInt(a.typeIndex), a.authenticatorData, a.clientDataJSON],
  );
}

export const encodeApproval = (signer: Hex, signature: Hex): Hex =>
  encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[signer], [signature]]);

export const encodePasskeyApproval = (verifier: Address, x: Hex, y: Hex, assertion: WebAuthnAssertion): Hex =>
  encodeApproval(passkeySigner(verifier, x, y), encodePasskeySignature(assertion));

export function encodeBackupApproval(eoa: Address, sig65: Hex): Hex {
  if (hexToBytes(sig65).length !== 65) throw new Error('backup signature must be 65 bytes r||s||v');
  return encodeApproval(backupSigner(eoa), sig65);
}

export async function signInvoiceAuthWithPasskey(
  credentialId: string,
  digest: Hex,
  key: { verifier: Address; x: Hex; y: Hex },
): Promise<Hex> {
  const challenge = hexToBytes(digest);
  if (challenge.length !== 32) throw new Error('digest must be 32 bytes');
  const sig = await signChallenge(credentialId, challenge as Uint8Array<ArrayBuffer>);
  return encodePasskeyApproval(key.verifier, key.x, key.y, sig);
}
