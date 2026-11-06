import { canonicalInvoiceJson, parseInvoice, type Invoice } from './invoice.ts';
import { cleanGst, readGst, type GstMeta } from './gst.ts';

const PREFIX = 'v1';

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('invalid base64url');
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
};
const importKey = (raw: Uint8Array<ArrayBuffer>, usage: KeyUsage) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);

/**
 * `gst` (optional) is display-only metadata: it is encrypted in the same payload, next to the invoice fields, but it is
 * not part of the canonical invoice, so the invoice hash, approvals and on-chain matching do not change (see lib/gst.ts).
 */
export async function encodeInvoiceLink(invoice: Invoice, origin: string, gst?: GstMeta | null): Promise<string> {
  const canonical = canonicalInvoiceJson(invoice);
  const meta = cleanGst(gst);
  const json = meta ? JSON.stringify({ ...JSON.parse(canonical), gst: meta }) : canonical;
  const plaintext = new TextEncoder().encode(json);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(keyBytes, 'encrypt'), plaintext),
  );
  const payload = new Uint8Array(iv.length + ct.length);
  payload.set(iv);
  payload.set(ct, iv.length);
  return `${origin.replace(/\/+$/, '')}/pay/#${PREFIX}.${b64url(payload)}.${b64url(keyBytes)}`;
}

async function decryptLink(url: string): Promise<unknown> {
  const fragment = url.slice(url.indexOf('#') + 1);
  const parts = fragment.split('.');
  if (url.indexOf('#') < 0 || parts.length !== 3 || parts[0] !== PREFIX) throw new Error('not a v1 invoice link');
  const payload = fromB64url(parts[1]);
  const keyBytes = fromB64url(parts[2]);
  if (keyBytes.length !== 32 || payload.length < 12 + 16) throw new Error('malformed invoice link');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: payload.slice(0, 12) },
    await importKey(keyBytes, 'decrypt'),
    payload.slice(12),
  );
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
}

export async function decodeInvoiceLink(url: string): Promise<Invoice> {
  return parseInvoice(await decryptLink(url));
}

/** The invoice plus the display-only metadata that travelled with it (GST details), if any. */
export async function decodeInvoiceLinkMeta(url: string): Promise<{ invoice: Invoice; gst: GstMeta | null }> {
  const raw = await decryptLink(url);
  return { invoice: parseInvoice(raw), gst: readGst((raw as { gst?: unknown } | null)?.gst) };
}
