import type { Address, Hex } from 'viem';

export type StoredPasskey = { credentialId: string; x: Hex; y: Hex; verifier: Address; approverAccount: Address };

const KEY = 'tazor.passkey.v1';

export function loadPasskey(): StoredPasskey | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as StoredPasskey) : null;
  } catch {
    return null;
  }
}

export function savePasskey(p: StoredPasskey): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}
