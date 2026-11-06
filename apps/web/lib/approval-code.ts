import { bytesToHex, getAddress, hexToBytes, isHex, type Hex } from 'viem';
import { parseApprovals, type Approval } from './payment.ts';

/**
 * Approvals passed between colleagues as a code instead of JSON: TZA1.<ref>.<payload>
 * ref = the first 4 bytes of the digest being approved (invoice or run), so a code pasted on the wrong invoice is caught
 * before anything is sent; payload = base64url(approver (20 bytes) ‖ signature).
 */
const PREFIX = 'TZA1';
const CODE_RE = /TZA1\.([0-9a-f]{8})\.([A-Za-z0-9_-]{20,})/g;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Short reference of what was approved: the first 4 bytes of the digest, as 8 hex characters. */
export const approvalRef = (digest: Hex): string => digest.slice(2, 10).toLowerCase();

export function encodeApprovalCode(a: Approval, digest: Hex): string {
  const sig = hexToBytes(a.signature);
  const payload = new Uint8Array(20 + sig.length);
  payload.set(hexToBytes(getAddress(a.approver)));
  payload.set(sig, 20);
  return `${PREFIX}.${approvalRef(digest)}.${b64url(payload)}`;
}

/** The text "Share my approval" copies: one readable line a colleague can paste whole. */
export const shareText = (a: Approval, digest: Hex, what: string) => `Tazor approval for ${what}: ${encodeApprovalCode(a, digest)}`;

/**
 * Approvals pasted by a person: one or more TZA1 codes anywhere in the text (a whole forwarded message works),
 * or the older JSON form. With `digest`, codes made for something else are refused with a readable reason.
 */
export function parseApprovalInput(text: string, digest?: Hex): Approval[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('{') || t.startsWith('[')) return parseApprovals(t);
  const out: Approval[] = [];
  for (const m of t.matchAll(CODE_RE)) {
    if (digest && m[1] !== approvalRef(digest)) throw new Error('This approval code is for a different invoice or run.');
    let bytes: Uint8Array;
    try { bytes = fromB64url(m[2]); } catch { throw new Error('This approval code is damaged; ask for it again.'); }
    if (bytes.length < 20 + 65) throw new Error('This approval code is incomplete; ask for it again.');
    const signature = bytesToHex(bytes.slice(20));
    if (!isHex(signature)) throw new Error('This approval code is damaged; ask for it again.');
    out.push({ approver: getAddress(bytesToHex(bytes.slice(0, 20))), signature });
  }
  if (out.length === 0) throw new Error('Paste the approval code a colleague shared (it starts with TZA1.).');
  return out;
}
