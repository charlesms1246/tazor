/**
 * Role bit positions in a company's ENSv2 registry (EAC root roles). Each company publishes them in its
 * `tazor.roles` text record, so anyone can read the bitmap without our code; the app checks it agrees.
 */
export const APP_ROLE_BITS = { APPROVER: 64, TAZOR_ADMIN: 68, AGENT: 72 } as const;

/** The `tazor.roles` value to publish: {"APPROVER":64,"TAZOR_ADMIN":68,"AGENT":72}. */
export const ROLE_BITS_RECORD = JSON.stringify(APP_ROLE_BITS);

/** Compares a published map with the bits the app and contracts use; lists every difference. */
export function compareRoleBits(published: Record<string, number> | null): { status: 'missing' | 'match' | 'mismatch'; diffs: string[] } {
  if (!published) return { status: 'missing', diffs: [] };
  const diffs: string[] = [];
  for (const [role, bit] of Object.entries(APP_ROLE_BITS)) {
    if (published[role] === undefined) diffs.push(`${role} not published`);
    else if (published[role] !== bit) diffs.push(`${role} is bit ${published[role]} on ENS, ${bit} in the contracts`);
  }
  return { status: diffs.length ? 'mismatch' : 'match', diffs };
}

/** "APPROVER 64 · TAZOR_ADMIN 68 · AGENT 72" */
export const roleBitsText = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ');
