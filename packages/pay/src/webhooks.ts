// Tazor webhooks: verify the Tazor-Signature header (t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>).
// Uses WebCrypto, so it runs in browsers, Node 18+, Deno and edge runtimes. Always verify the RAW body string.

export type WebhookEvent = { id: string; type: string; created: number; data: Record<string, unknown>; chainId: number; txHash?: string; explorer?: string };
export type VerifyResult = { ok: true; event: WebhookEvent; timestamp: number } | { ok: false; reason: string };

const enc = new TextEncoder();
const toHexStr = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHexStr(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

/** Constant-time comparison of two hex strings. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && /^\d+$/.test(v ?? '')) t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v ?? '')) v1.push(v.toLowerCase());
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

/** Builds a Tazor-Signature header (for tests and for your own forwarding). */
export async function signWebhook(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** Checks the signature and the timestamp window (default ±300 s), then parses the event. */
export async function verifyWebhook(rawBody: string, header: string | null | undefined, secret: string, tolerance = 300, now = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  const h = header ? parseSignatureHeader(header) : null;
  if (!h) return { ok: false, reason: 'missing or malformed Tazor-Signature header' };
  if (Math.abs(now - h.t) > tolerance) return { ok: false, reason: `timestamp outside the ${tolerance} s window (replay?)` };
  const expected = await hmacHex(secret, `${h.t}.${rawBody}`);
  if (!h.v1.some((s) => equal(s, expected))) return { ok: false, reason: 'signature does not match' };
  try {
    return { ok: true, event: JSON.parse(rawBody) as WebhookEvent, timestamp: h.t };
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
}
