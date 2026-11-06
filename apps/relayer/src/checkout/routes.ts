import type { IncomingMessage } from 'node:http';
import { getAddress, isAddress, isHex, size, type Address, type Hex } from 'viem';
import { BadRequest } from '../payment.ts';
import { SimulationFailed } from '../sender.ts';
import type { Guard, GuardedRoute } from '../guard.ts';
import type { Webhooks } from '../webhooks.ts';
import { clientIp } from '../sandbox/routes.ts';
import { Conflict, type Checkout } from './service.ts';
import { recentWithReplay } from './replay.ts';
import { orderFromQuery, type Deposit, type DepositOrder } from './deposit.ts';
import { X402_NETWORKS, decodeHeader, demoRequirements, encodeHeader, freightQuote, type X402 } from './x402.ts';

export const CHECKOUT_ROUTES = [
  'POST /checkout/pay', 'POST /checkout/refund', 'POST /checkout/subscribe', 'POST /checkout/cancel', 'POST /checkout/charge',
  'GET /checkout/order/:id', 'GET /checkout/subscription/:id',
  'POST /checkout/deposit/settle', 'GET /checkout/deposit/status?order=<base64url JSON>', 'POST /checkout/deposit/refund',
];
export const X402_ROUTES = ['GET /x402/supported', 'POST /x402/verify', 'POST /x402/settle', 'GET /x402/settlements?payTo=', 'GET /x402/demo/freight-quote?from=&to='];
export const WEBHOOK_ROUTES = ['GET /webhooks/recent?merchant=', 'POST /webhooks/test'];

type Reply = (status: number, body: unknown, headers?: Record<string, string>) => void;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const id32 = (v: unknown) => (typeof v === 'string' && isHex(v) && size(v) === 32 ? v : undefined);

/**
 * /checkout/*, /x402/* and /webhooks/*. Returns false for other paths. Pre-check conflicts are 409 {error, code};
 * everything else falls through to the shared error handling (400, 422, 429, 503, 502).
 */
export async function handleCheckout(
  req: IncomingMessage, url: URL, deps: { checkout?: Checkout; deposit?: Deposit; x402?: X402; webhooks?: Webhooks; guard?: Guard; payTo?: Address },
  readJson: (req: IncomingMessage) => Promise<unknown>, reply: Reply,
): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  if (!/^\/(checkout|x402|webhooks)(\/|$)/.test(path)) return false;
  const guard = (route: GuardedRoute, keys: (string | undefined)[]) => deps.guard?.check(route, clientIp(req), keys);
  try {
    // ---- pay by plain transfer (deposit address per order)
    if (path.startsWith('/checkout/deposit')) {
      const dep = deps.deposit;
      if (!dep) return reply(503, { error: 'deposit checkout is not configured on this relayer' }), true;
      const byMerchant = async (o: DepositOrder) => { await guard('/checkout/deposit/settle', [o.merchant]); };
      if (m === 'POST' && path === '/checkout/deposit/settle') return reply(200, await dep.settle(await readJson(req), byMerchant)), true;
      if (m === 'GET' && path === '/checkout/deposit/status') return reply(200, await dep.status(orderFromQuery(url.searchParams.get('order')), byMerchant)), true;
      if (m === 'POST' && path === '/checkout/deposit/refund') {
        const b = (await readJson(req)) as Record<string, unknown> | null;
        await guard('/checkout/deposit/refund', [str(b?.id) ?? str(b?.orderId)]);
        return reply(200, await dep.refund(b)), true;
      }
      return reply(404, { error: 'not found' }), true;
    }

    // ---- checkout
    if (path.startsWith('/checkout')) {
      const c = deps.checkout;
      if (!c) return reply(503, { error: 'checkout is not configured on this relayer (CHECKOUT_ADDRESS and a relayer key)' }), true;
      const write: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
        '/checkout/pay': async (b) => { const o = (b.order ?? {}) as Record<string, unknown>; await guard('/checkout/pay', [str(b.payer), str(o.merchant)]); return c.pay(b); },
        '/checkout/refund': async (b) => { await guard('/checkout/refund', [str(b.id) ?? str(b.orderId)]); return c.refund(b); },
        '/checkout/subscribe': async (b) => { const p = (b.plan ?? {}) as Record<string, unknown>; await guard('/checkout/subscribe', [str(b.payer), str(p.merchant)]); return c.subscribe(b); },
        '/checkout/cancel': async (b) => { await guard('/checkout/cancel', [str(b.subId) ?? str(b.id)]); return c.cancel(b); },
        '/checkout/charge': async (b) => { await guard('/checkout/charge', [str(b.subId) ?? str(b.id)]); return c.charge(b); },
      };
      if (m === 'POST' && write[path]) {
        const b = await readJson(req);
        if (typeof b !== 'object' || b === null) throw new BadRequest('body must be a JSON object');
        return reply(200, await write[path](b as Record<string, unknown>)), true;
      }
      const order = path.match(/^\/checkout\/order\/([^/]+)$/);
      if (m === 'GET' && order) return reply(200, await c.order(decodeURIComponent(order[1]))), true;
      const sub = path.match(/^\/checkout\/subscription\/([^/]+)$/);
      if (m === 'GET' && sub) return reply(200, await c.subscription(decodeURIComponent(sub[1]))), true;
      return reply(404, { error: 'not found' }), true;
    }

    // ---- x402 facilitator
    if (path.startsWith('/x402')) {
      const x = deps.x402;
      if (!x) return reply(503, { error: 'the x402 facilitator is not configured on this relayer' }), true;
      if (m === 'GET' && path === '/x402/supported') return reply(200, x.supported()), true;
      if (m === 'POST' && path === '/x402/verify') return reply(200, await x.verify(await readJson(req))), true;
      if (m === 'POST' && path === '/x402/settle') {
        return reply(200, await x.settle(await readJson(req), async (payer) => { await guard('/x402/settle', [payer]); })), true;
      }
      if (m === 'GET' && path === '/x402/settlements') {
        const payTo = url.searchParams.get('payTo');
        if (!payTo || !isAddress(payTo)) throw new BadRequest('payTo must be an address');
        return reply(200, { payTo: getAddress(payTo), storage: deps.webhooks?.storage ?? 'memory', note: storageNote(deps.webhooks), items: await x.settlements(getAddress(payTo)) }), true;
      }
      if (m === 'GET' && path === '/x402/demo/freight-quote') {
        if (!deps.payTo) return reply(503, { error: 'the demo resource has no payTo (set X402_PAYTO)' }), true;
        const from = url.searchParams.get('from') || 'Mumbai';
        const to = url.searchParams.get('to') || 'Pune';
        const requirements = demoRequirements(`${originOf(req)}/x402/demo/freight-quote?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, deps.payTo);
        const header = req.headers['x-payment'];
        const paymentPayload = typeof header === 'string' && header ? decodeHeader(header) : null;
        if (!paymentPayload) return reply(402, { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [requirements] }), true;
        const r = await x.settle({ x402Version: 1, paymentPayload, paymentRequirements: requirements }, async (payer) => { await guard('/x402/settle', [payer]); });
        if (!r.success) return reply(402, { x402Version: 1, error: r.errorReason, accepts: [requirements] }), true;
        return reply(200, { ...freightQuote(from, to), paidWith: { transaction: r.transaction, network: r.network, payer: r.payer } }, { 'x-payment-response': encodeHeader(r) }), true;
      }
      return reply(404, { error: 'not found' }), true;
    }

    // ---- webhooks
    const w = deps.webhooks;
    if (!w) return reply(503, { error: 'webhooks are not configured' }), true;
    if (m === 'GET' && path === '/webhooks/recent') {
      const merchant = url.searchParams.get('merchant');
      if (!merchant || !isAddress(merchant)) throw new BadRequest('merchant must be an address');
      const stored = await w.recent(getAddress(merchant));
      const { items, replayed } = await recentWithReplay(getAddress(merchant), stored, w.secretFor(merchant));
      return reply(200, { merchant: getAddress(merchant), storage: w.storage, note: storageNote(w), replayed, replayNote: 'Events not in this instance\'s delivery log are rebuilt from Whitechain and signed with the merchant\'s secret (status "signed").', items, deliveries: items }), true;
    }
    if (m === 'POST' && path === '/webhooks/test') {
      const b = (await readJson(req)) as { merchant?: unknown } | null;
      const merchant = b?.merchant;
      if (typeof merchant !== 'string' || !isAddress(merchant)) throw new BadRequest('merchant must be an address');
      if (!w.hasEndpoint(merchant)) return reply(404, { error: 'no endpoint configured for this merchant' }), true;
      await guard('/webhooks/test', [merchant]);
      const d = await w.emit({ id: `test:${Date.now()}`, type: 'webhook.test', merchant, data: { message: 'Test event from the Tazor relayer', merchant: getAddress(merchant) }, force: true });
      return reply(200, d), true;
    }
    return reply(404, { error: 'not found' }), true;
  } catch (e) {
    if (e instanceof Conflict) return reply(409, { error: e.message, code: e.code, ...e.extra }), true;
    if (e instanceof SimulationFailed) return reply(422, { error: `simulation reverted: ${e.message}` }), true;
    throw e;
  }
}

const storageNote = (w?: Webhooks) => (w?.storage === 'kv'
  ? 'stored in the configured KV store (shared by every relayer instance)'
  : 'kept in this server instance\'s memory only: another instance (or a restart) shows a different list');

function originOf(req: IncomingMessage) {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

export { X402_NETWORKS, id32 };
export type { Hex };
