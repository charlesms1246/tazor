/**
 * Merchant analytics from on-chain checkout data (the same orders and subscriptions the /checkout/ console reads).
 * Pure: no network. A "payment" is a checkout order (wallet signature or exchange transfer) or a subscription charge.
 */
import type { Address } from 'viem';
import type { OrderRow, SubRow } from './checkout.ts';

export type Channel = 'wallet' | 'transfer' | 'subscription';
export type DayNet = { day: string; net: bigint };
export type CustomerTotal = { payer: Address; payments: number; net: bigint };
export type SalesStats = {
  gross: bigint; refunds: bigint; net: bigint;
  payments: number; orders: number; charges: number; average: bigint;
  customers: number; repeatCustomers: number;
  /** refunds / gross, 0..1 (0 when there are no sales) */
  refundRate: number;
  byChannel: Record<Channel, { count: number; gross: bigint }>;
  daily: DayNet[];
  topCustomers: CustomerTotal[];
};

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Payment = { payer: Address; amount: bigint; at: number | null; channel: Channel };
type Refund = { payer: Address; amount: bigint; at: number | null };

function flatten(orders: OrderRow[], subs: SubRow[]): { pays: Payment[]; refunds: Refund[] } {
  const pays: Payment[] = [];
  const refunds: Refund[] = [];
  for (const o of orders) {
    pays.push({ payer: o.payer, amount: o.amount, at: o.paidAt, channel: o.method === 'transfer' ? 'transfer' : 'wallet' });
    for (const r of o.refunds) refunds.push({ payer: o.payer, amount: r.amount, at: r.at });
  }
  for (const s of subs) for (const c of s.charges) pays.push({ payer: s.payer, amount: c.amount, at: c.at, channel: 'subscription' });
  return { pays, refunds };
}

/** Totals, mix, a daily net series (the last `days` days up to `now`, UTC) and the top customers by net. */
export function salesStats(view: { orders: OrderRow[]; subs: SubRow[] }, opts: { now?: number; days?: number; top?: number } = {}): SalesStats {
  const { pays, refunds } = flatten(view.orders, view.subs);
  const gross = pays.reduce((s, p) => s + p.amount, 0n);
  const refunded = refunds.reduce((s, r) => s + r.amount, 0n);
  const byChannel: SalesStats['byChannel'] = { wallet: { count: 0, gross: 0n }, transfer: { count: 0, gross: 0n }, subscription: { count: 0, gross: 0n } };
  for (const p of pays) { byChannel[p.channel].count++; byChannel[p.channel].gross += p.amount; }

  const per = new Map<string, CustomerTotal>();
  const cust = (payer: Address) => {
    const k = payer.toLowerCase();
    let c = per.get(k);
    if (!c) { c = { payer, payments: 0, net: 0n }; per.set(k, c); }
    return c;
  };
  for (const p of pays) { const c = cust(p.payer); c.payments++; c.net += p.amount; }
  for (const r of refunds) cust(r.payer).net -= r.amount;

  const now = opts.now ?? Date.now();
  const days = opts.days ?? 14;
  const series = new Map<string, bigint>();
  for (let i = days - 1; i >= 0; i--) series.set(dayOf(now - i * DAY), 0n);
  for (const p of pays) if (p.at !== null) { const d = dayOf(p.at); if (series.has(d)) series.set(d, series.get(d)! + p.amount); }
  for (const r of refunds) if (r.at !== null) { const d = dayOf(r.at); if (series.has(d)) series.set(d, series.get(d)! - r.amount); }

  const customers = [...per.values()];
  return {
    gross, refunds: refunded, net: gross - refunded,
    payments: pays.length, orders: view.orders.length, charges: byChannel.subscription.count,
    average: pays.length ? gross / BigInt(pays.length) : 0n,
    customers: customers.length, repeatCustomers: customers.filter((c) => c.payments >= 2).length,
    refundRate: gross > 0n ? Number((refunded * 10_000n) / gross) / 10_000 : 0,
    byChannel,
    daily: [...series.entries()].map(([day, net]) => ({ day, net })),
    topCustomers: customers.sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : b.payments - a.payments)).slice(0, opts.top ?? 5),
  };
}

/** Net sales (payments − refunds) with a timestamp in [from, to) ms; for "pay suppliers from sales". */
export function netSales(view: { orders: OrderRow[]; subs: SubRow[] }, from: number, to = Number.POSITIVE_INFINITY): { gross: bigint; refunds: bigint; net: bigint; payments: number } {
  const { pays, refunds } = flatten(view.orders, view.subs);
  const inP = (at: number | null) => at !== null && at >= from && at < to;
  const g = pays.filter((p) => inP(p.at));
  const r = refunds.filter((x) => inP(x.at));
  const gross = g.reduce((s, p) => s + p.amount, 0n);
  const ref = r.reduce((s, x) => s + x.amount, 0n);
  return { gross, refunds: ref, net: gross - ref, payments: g.length };
}

export const CHANNEL_LABEL: Record<Channel, string> = { wallet: 'Wallet signature', transfer: 'Exchange or wallet transfer', subscription: 'Subscription' };
