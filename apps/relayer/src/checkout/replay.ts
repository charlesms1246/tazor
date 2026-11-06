// Webhook replay from the chain: every webhook event comes from an on-chain event, so a merchant's events can be
// rebuilt and re-signed at any time. Nothing is lost when a serverless instance restarts or a delivery failed.
import type { Address } from 'viem';
import { merchantHistory, type HistoryRow } from '../../../../packages/pay/src/checkout.ts';
import { sign, type Delivery, type EventType } from '../webhooks.ts';

const EXPLORER = 'https://explorer.testnet.whitechain.io';
const usdt = (v: bigint) => { const s = v.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`; };

/** The webhook event a history row stands for (null for rows that send none). */
export function eventFor(r: HistoryRow): { type: EventType; id: string; data: Record<string, unknown> } | null {
  const source = r.method === 'deposit' ? 'deposit' : 'checkout';
  switch (r.kind) {
    case 'paid': return { type: 'order.paid', id: `${r.id}:paid`, data: { orderId: r.id, payer: r.payer, amount: r.amount.toString(), amountUsdt: usdt(r.amount), ref: r.ref, source } };
    case 'deposit-paid': return { type: 'order.paid', id: `${r.id}:paid`, data: { orderId: r.id, payer: r.payer, amount: r.amount.toString(), amountUsdt: usdt(r.amount), ref: r.ref, source } };
    case 'refunded':
    case 'deposit-refunded': return { type: 'order.refunded', id: `${r.id}:refund:${r.tx}`, data: { orderId: r.id, payer: r.payer, amount: r.amount.toString(), amountUsdt: usdt(r.amount), totalRefunded: r.totalRefunded.toString(), source } };
    case 'subscribed': return { type: 'subscription.created', id: `${r.id}:created`, data: { subId: r.id, payer: r.payer, amount: r.amount.toString(), period: r.period, cycles: r.cycles } };
    case 'charged': return { type: 'subscription.charged', id: `${r.id}:charged:${r.cycle}`, data: { subId: r.id, cycle: r.cycle, amount: r.amount.toString() } };
    case 'cancelled': return { type: 'subscription.cancelled', id: `${r.id}:cancelled`, data: { subId: r.id, by: r.by } };
    default: return null;
  }
}

/** Rebuild a merchant's signed events from Whitechain, newest first. Signed with the merchant's secret at the block time. */
export function replayDeliveries(merchant: Address, rows: HistoryRow[], secret: string, chainId = 1874): Delivery[] {
  const out: Delivery[] = [];
  for (const r of rows) {
    const e = eventFor(r);
    if (!e) continue;
    const created = r.time;
    const explorer = `${EXPLORER}/tx/${r.tx}`;
    const rawBody = JSON.stringify({ id: e.id, type: e.type, created, data: e.data, chainId, txHash: r.tx, explorer });
    out.push({
      id: e.id, type: e.type, merchant: merchant.toLowerCase(), created, txHash: r.tx, data: e.data,
      status: 'signed', attempts: 0, rawBody, signature: sign(secret, rawBody, created), explorer,
    });
  }
  return out.reverse();
}

/** Stored deliveries first (they carry the real delivery status), then chain-rebuilt events not already listed. */
export async function recentWithReplay(merchant: Address, stored: Delivery[], secret: string | undefined, read = merchantHistory): Promise<{ items: Delivery[]; replayed: number }> {
  if (!secret) return { items: stored, replayed: 0 };
  const rows = await read(merchant).catch(() => [] as HistoryRow[]);
  const seen = new Set(stored.map((d) => `${d.type}:${(d.txHash ?? '').toLowerCase()}`));
  const extra = replayDeliveries(merchant, rows, secret).filter((d) => !seen.has(`${d.type}:${(d.txHash ?? '').toLowerCase()}`));
  const items = [...stored, ...extra].sort((a, b) => b.created - a.created).slice(0, 50);
  return { items, replayed: extra.length };
}
