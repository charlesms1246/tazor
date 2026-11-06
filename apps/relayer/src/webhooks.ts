import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, type Hex } from 'viem';

export const WEBHOOK_TOLERANCE_SEC = 300;
export const EVENT_TYPES = [
  'order.paid', 'order.ready', 'order.refunded', 'order.finality',
  'subscription.created', 'subscription.charged', 'subscription.cancelled', 'subscription.due',
  'x402.settled', 'webhook.test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** `Tazor-Signature: t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<rawBody>")>` */
export function sign(secret: string, rawBody: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

/** Checks a Tazor-Signature header (any v1 may match, for secret rotation); rejects timestamps more than 5 minutes off. */
export function verify(secret: string, rawBody: string, header: string | null | undefined, nowSec = Math.floor(Date.now() / 1000), toleranceSec = WEBHOOK_TOLERANCE_SEC): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, rawBody, t).split('v1=')[1], 'hex');
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const got = Buffer.from(v ?? '', 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** A merchant's webhook: POSTed to `url`; without a url the event is only signed and recorded (read it from /webhooks/recent). */
export type Endpoint = { url?: string; secret: string; /** USDT: payments at or above wait for Ethereum before order.ready (default 100). */ shipAbove?: string };

/** The public demo merchant (examples/merchant-demo) and its test secret, public on purpose: its page verifies deliveries in the browser. */
export const DEMO_MERCHANT = '0xc1dce946d192e344251972470237f1471c93876c';
export const DEMO_SECRET = 'whsec_tazor_demo_test';

/** WEBHOOKS_JSON = {"<merchant address>": {"url": "https://…", "secret": "…"}}; invalid entries are dropped. */
export function endpointsFromEnv(json: string | undefined): Record<string, Endpoint> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, { url?: unknown; secret?: unknown }>;
    const out: Record<string, Endpoint> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!isAddress(k, { strict: false }) || typeof v?.secret !== 'string' || !v.secret) continue;
      if (v.url !== undefined && (typeof v.url !== 'string' || !/^https?:\/\//.test(v.url))) continue;
      const shipAbove = (v as { shipAbove?: unknown }).shipAbove;
      out[k.toLowerCase()] = { ...(typeof v.url === 'string' ? { url: v.url } : {}), secret: v.secret, ...(typeof shipAbove === 'string' && /^\d+(\.\d{1,6})?$/.test(shipAbove) ? { shipAbove } : {}) };
    }
    return out;
  } catch { return {}; }
}

export type Delivery = {
  id: string; type: EventType; merchant: string; created: number; txHash: Hex | null;
  status: 'delivered' | 'failed' | 'signed' | 'no-endpoint'; attempts: number; httpStatus?: number; data: Record<string, unknown>;
  /** The exact body that was signed and the Tazor-Signature header of the last attempt (null without an endpoint). */
  rawBody: string; signature: string | null; explorer: string | null;
};

/** Upstash Redis REST (KV_REST_API_URL + KV_REST_API_TOKEN): one command per POST, `["LPUSH", key, value]`. */
export function upstashStore(url: string, token: string, f: typeof fetch = (...a) => globalThis.fetch(...a)) {
  const cmd = async (...args: (string | number)[]): Promise<unknown> => {
    const r = await f(url.replace(/\/+$/, ''), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`kv HTTP ${r.status}`);
    return ((await r.json()) as { result?: unknown }).result;
  };
  return {
    kind: 'kv' as const,
    /** true the first time an id is claimed (SET NX, kept 7 days). */
    claim: async (id: string) => (await cmd('SET', `tazor:wh:done:${id}`, '1', 'NX', 'EX', 604_800)) === 'OK',
    push: async (merchant: string, d: Delivery) => { await cmd('LPUSH', `tazor:wh:${merchant}`, JSON.stringify(d)); await cmd('LTRIM', `tazor:wh:${merchant}`, 0, 99); },
    list: async (merchant: string) => ((await cmd('LRANGE', `tazor:wh:${merchant}`, 0, 49)) as string[] ?? []).map((s) => JSON.parse(s) as Delivery),
  };
}

/** Per-instance memory: deliveries vanish on a cold start and differ between serverless instances. */
export function memoryStore(max = 200) {
  const ring: Delivery[] = [];
  const done = new Set<string>();
  return {
    kind: 'memory' as const,
    claim: async (id: string) => { if (done.has(id)) return false; done.add(id); return true; },
    push: async (_merchant: string, d: Delivery) => { ring.unshift(d); ring.length = Math.min(ring.length, max); },
    list: async (merchant: string) => ring.filter((d) => d.merchant === merchant).slice(0, 50),
  };
}
export type Store = ReturnType<typeof memoryStore> | ReturnType<typeof upstashStore>;

/**
 * Signed webhook delivery: one POST per event, up to 3 retries with backoff. Each event id is delivered once
 * (claimed in the store first), so a re-observed stage or a retried request never sends it twice.
 */
export function createWebhooks(o: {
  endpoints: Record<string, Endpoint>; store?: Store; f?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  chainId?: number; explorer?: string; retries?: number;
  /** Demo only: sign (record-only) events of merchants without an endpoint with this public secret. */
  demoSecret?: string;
}) {
  const store = o.store ?? memoryStore();
  const f = o.f ?? ((...a) => globalThis.fetch(...a));
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 3;
  const chainId = o.chainId ?? 1874;
  const explorer = o.explorer ?? 'https://explorer.testnet.whitechain.io';

  async function post(ep: Required<Endpoint>, body: string): Promise<{ ok: boolean; status?: number; attempts: number; signature: string }> {
    let last: number | undefined;
    let signature = '';
    for (let i = 0; i <= retries; i++) {
      if (i) await sleep(250 * 2 ** (i - 1));
      signature = sign(ep.secret, body, Math.floor(now() / 1000));
      try {
        const r = await f(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', 'tazor-signature': signature }, body, signal: AbortSignal.timeout(4000) });
        last = r.status;
        if (r.ok) return { ok: true, status: r.status, attempts: i + 1, signature };
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { ok: false, status: r.status, attempts: i + 1, signature };
      } catch { /* network error or timeout: retry */ }
    }
    return { ok: false, status: last, attempts: retries + 1, signature };
  }

  /** Delivers one event to the merchant's endpoint (if any) and records it; returns null when this id was already handled. */
  async function emit(e: { id: string; type: EventType; merchant: string; data: Record<string, unknown>; txHash?: Hex | null; force?: boolean }): Promise<Delivery | null> {
    const merchant = getAddress(e.merchant).toLowerCase();
    if (!e.force && !(await store.claim(e.id).catch(() => true))) return null;
    const created = Math.floor(now() / 1000);
    const txHash = e.txHash ?? null;
    const txUrl = txHash ? `${explorer}/tx/${txHash}` : null;
    const body = JSON.stringify({ id: e.id, type: e.type, created, data: e.data, chainId, txHash, explorer: txUrl });
    const ep = o.endpoints[merchant] ?? (o.demoSecret ? { secret: o.demoSecret } : undefined);
    const r = ep?.url ? await post(ep as Required<Endpoint>, body) : null;
    const recordOnly = ep && !ep.url ? sign(ep.secret, body, created) : null;
    const d: Delivery = {
      id: e.id, type: e.type, merchant, created, txHash, data: e.data,
      status: recordOnly ? 'signed' : !r ? 'no-endpoint' : r.ok ? 'delivered' : 'failed', attempts: r?.attempts ?? 0, ...(r?.status !== undefined ? { httpStatus: r.status } : {}),
      rawBody: body, signature: r?.signature ?? recordOnly, explorer: txUrl,
    };
    await store.push(merchant, d).catch(() => undefined);
    return d;
  }

  return {
    emit,
    hasEndpoint: (merchant: string) => !!o.endpoints[merchant.toLowerCase()]?.url,
    /** The merchant's shipping rule (WEBHOOKS_JSON shipAbove, default 100 USDT). */
    shipPolicyFor: (merchant: string) => ({ waitForEthereumAbove: o.endpoints[merchant.toLowerCase()]?.shipAbove ?? '100' }),
    merchants: () => Object.keys(o.endpoints).length,
    storage: store.kind,
    recent: (merchant: string) => store.list(getAddress(merchant).toLowerCase()),
    /** The secret this merchant's events are signed with (its endpoint's, else the demo secret), if any. */
    secretFor: (merchant: string) => o.endpoints[merchant.toLowerCase()]?.secret ?? o.demoSecret,
  };
}
export type Webhooks = ReturnType<typeof createWebhooks>;
