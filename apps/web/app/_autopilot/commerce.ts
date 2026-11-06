/**
 * The Checkout chapter's calls: simulated customers, exchange deposits and AI agents run on the relayer sandbox;
 * the presenter (the merchant) signs refunds with their browser wallet, or the sandbox merchant signs when there
 * is no wallet. Injected deps keep it testable without a browser.
 */
import type { Hex } from 'viem';
import type { ApiResult, Ctx } from './engine.ts';
import type { SandboxClient } from '../../lib/sandbox.ts';
import { isSandboxError } from '../../lib/sandbox.ts';
import type { Signer } from '../../lib/checkout.ts';

export type CommerceDeps = {
  client: SandboxClient;
  relayer: () => string;
  /** The browser wallet (EIP-1193), or null when the page has none. */
  wallet: () => Promise<Signer | null>;
  refund: (a: { id: Hex; amount: bigint; wallet: Signer; method: 'signed' | 'transfer'; relayer: string }) => Promise<{ txHash: Hex }>;
  fetch?: typeof fetch;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
export const REFUND = 20_000n; // 0.02 USDT

export function commerceApi(d: CommerceDeps) {
  const f = d.fetch ?? ((...a) => globalThis.fetch(...a));

  async function sandbox(action: string, params: Record<string, unknown>): Promise<ApiResult> {
    const r = await d.client.counterparty(action as never, params as never);
    const b = r.body as unknown as Record<string, unknown>;
    if (isSandboxError(r.body)) return { ok: false, error: r.body.reason || r.body.error };
    const data: Ctx = {};
    for (const k of ['orderId', 'customer', 'merchant', 'orderParam', 'depositAddress', 'agent', 'amount', 'payTo']) if (b[k] !== undefined) data[k === 'amount' ? `${action}Amount` : k] = str(b[k]);
    const quote = b.quote as { from?: string; to?: string; priceINR?: number; distanceKm?: number; transitDays?: number } | undefined;
    if (quote) data.quote = `${quote.from} → ${quote.to}: ${quote.distanceKm} km, ₹${quote.priceINR}, ${quote.transitDays} day(s)`;
    return { ok: true, status: str(b.status), tx: str(b.txHash ?? b.tx) || undefined, chain: 'whitechain', detail: str(b.detail) || undefined, data };
  }

  return {
    /** The merchant for this chapter: the presenter's wallet if there is one (it then signs the refund). */
    async walletAddress(): Promise<ApiResult> {
      try {
        const w = await d.wallet();
        if (w) return { ok: true, detail: `You are the merchant: your wallet ${short(w.address)} receives the payment and signs the refund`, data: { merchantWallet: w.address, refundBy: 'wallet' } };
      } catch { /* the presenter declined: fall back to the sandbox merchant */ }
      return { ok: true, detail: 'No browser wallet: the sandbox merchant receives the payment and signs the refund', data: { merchantWallet: '', refundBy: 'sandbox' } };
    },

    customerPays: (c: Ctx) => sandbox('checkout-customer-pay', { merchant: c.merchantWallet || '' }),

    /** 0.02 USDT back to the customer: the merchant's wallet signs (the relayer pays the gas), or the sandbox merchant. */
    async refund(c: Ctx): Promise<ApiResult> {
      if (!c.orderId) return { ok: false, error: 'No order to refund yet' };
      if (c.refundBy === 'wallet') {
        const w = await d.wallet();
        if (!w) return { ok: false, error: 'The browser wallet is gone; reconnect it' };
        if (w.address.toLowerCase() !== (c.merchant ?? '').toLowerCase()) return { ok: false, error: `Switch your wallet to the merchant ${short(c.merchant ?? '')}` };
        const r = await d.refund({ id: c.orderId as Hex, amount: REFUND, wallet: w, method: 'signed', relayer: d.relayer() });
        return { ok: true, tx: r.txHash, chain: 'whitechain', detail: 'Refunded 0.02 USDT to the customer; your wallet signed, Tazor paid the gas' };
      }
      return sandbox('checkout-merchant-refund', { orderId: c.orderId, amount: '0.02' });
    },

    depositPays: (c: Ctx) => sandbox('deposit-customer-pay', { merchant: c.merchantWallet || '' }),

    /** Polls the deposit order; the relayer settles it as soon as the transfer is there. */
    async depositStatus(c: Ctx): Promise<ApiResult> {
      const base = d.relayer().replace(/\/+$/, '');
      if (!base) return { ok: false, error: 'No relayer configured' };
      if (!c.orderParam) return { ok: false, error: 'No deposit order yet' };
      try {
        const res = await f(`${base}/checkout/deposit/status?order=${c.orderParam}`, { signal: AbortSignal.timeout(60_000) });
        const j = (await res.json()) as { id?: string; status?: string; payTx?: string; error?: string };
        if (!res.ok) return { ok: false, error: j.error ?? `relayer returned ${res.status}` };
        const paid = j.status === 'paid' || j.status === 'partially-refunded' || j.status === 'refunded';
        return {
          ok: true, status: j.status, ...(paid && j.payTx ? { tx: j.payTx } : {}), chain: 'whitechain',
          detail: paid ? 'The deposit settled: the merchant is paid, any excess went back' : `Deposit status: ${j.status}`, data: { depositOrderId: str(j.id) },
        };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },

    agentPays: () => sandbox('agent-x402', { from: 'Mumbai', to: 'Pune' }),
  };
}
export type CommerceApi = ReturnType<typeof commerceApi>;
