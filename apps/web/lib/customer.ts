/**
 * The customer's side: every Checkout payment one address made, across all businesses, and its subscriptions,
 * read straight from Whitechain (no account, no merchant login).
 * Signed payments are found by the indexed payer; exchange payments by their refund address (payment(id).refundTo).
 */
import { decodeFunctionResult, encodeEventTopics, encodeFunctionData, pad, type Address, type Hex } from 'viem';
import {
  blockTime, checkoutAbi, checkoutAddress, chunkedLogs, decodeCheckoutLogs, depositAbi, depositCheckoutAddress, explorerLogs,
  type PayMethod, type RawLog,
} from './checkout.ts';
import { ethCall } from './rpc.ts';

export type CustomerOrder = {
  id: Hex; method: PayMethod; merchant: Address; amount: bigint; refunded: bigint; net: bigint; paidAt: number | null; tx: Hex | null;
  refunds: { amount: bigint; tx: Hex; at: number | null }[];
};
export type CustomerSub = {
  id: Hex; merchant: Address; amount: bigint; period: number; cycles: number; charged: number; active: boolean; started: number | null; nextAt: number | null;
};
export type CustomerHistory = { orders: CustomerOrder[]; subs: CustomerSub[]; totals: { paid: bigint; refunded: bigint; net: bigint } };

export type CustomerDeps = {
  call: (to: Address, data: Hex) => Promise<Hex>;
  logs: (contract: Address, topics: (Hex | null)[]) => Promise<RawLog[]>;
  explorer: (contract: Address) => Promise<RawLog[]>;
  time: (block: number) => Promise<number | null>;
  checkout: Address | null;
  deposit: Address | null;
  /** How many exchange payments to check for this refund address (one read each). */
  maxDeposits?: number;
};

const defaults = (): CustomerDeps => ({
  call: ethCall, logs: chunkedLogs, explorer: (c) => explorerLogs(c, 8), time: (b) => blockTime(b).catch(() => null),
  checkout: checkoutAddress(), deposit: depositCheckoutAddress(),
});

const topicOf = (a: Address) => pad(a.toLowerCase() as Hex, { size: 32 });
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function view<T>(call: CustomerDeps['call'], to: Address, abi: typeof checkoutAbi | typeof depositAbi, functionName: string, args: unknown[]): Promise<T> {
  const data = await call(to, encodeFunctionData({ abi, functionName, args } as never));
  return decodeFunctionResult({ abi, functionName, data } as never) as T;
}

export async function customerHistory(customer: Address, over: Partial<CustomerDeps> = {}): Promise<CustomerHistory> {
  const d = { ...defaults(), ...over };
  const me = topicOf(customer);
  const times = new Map<number, Promise<number | null>>();
  const timeOf = (b: number) => { if (!times.has(b)) times.set(b, d.time(b)); return times.get(b)!; };
  const orders: CustomerOrder[] = [];
  const subs: CustomerSub[] = [];

  // ---- signed in a wallet: OrderPaid, Refunded and Subscribed all index the payer (topic 3)
  if (d.checkout) {
    const evs = decodeCheckoutLogs(await d.logs(d.checkout, [null, null, null, me]));
    for (const e of evs) {
      if (e.kind !== 'paid' || !same(e.payer, customer)) continue;
      const refunds = await Promise.all(evs.filter((r) => r.kind === 'refunded' && r.id === e.id)
        .map(async (r) => ({ amount: (r as { amount: bigint }).amount, tx: r.tx, at: r.at ?? await timeOf(r.block) })));
      const [, , amount, refunded, paidAt] = await view<readonly [Address, Address, bigint, bigint, bigint, number]>(d.call, d.checkout, checkoutAbi, 'payment', [e.id]);
      orders.push({ id: e.id, method: 'signed', merchant: e.merchant, amount, refunded, net: amount - refunded, paidAt: paidAt ? Number(paidAt) * 1000 : e.at ?? await timeOf(e.block), tx: e.tx, refunds });
    }
    for (const e of evs) {
      if (e.kind !== 'subscribed' || !same(e.payer, customer)) continue;
      const [merchant, , amount, period, cycles, charged, start, active] =
        await view<readonly [Address, Address, bigint, number, number, number, bigint, boolean]>(d.call, d.checkout, checkoutAbi, 'subscription', [e.id]);
      let nextAt: number | null = null;
      if (active && charged < cycles) { try { nextAt = Number(await view<bigint>(d.call, d.checkout, checkoutAbi, 'nextChargeAt', [e.id])) * 1000; } catch { nextAt = null; } }
      subs.push({ id: e.id, merchant, amount, period: Number(period), cycles: Number(cycles), charged: Number(charged), active, started: start ? Number(start) * 1000 : null, nextAt });
    }
  }

  // ---- sent from an exchange: found by the order's refund address
  if (d.deposit) {
    const dep = d.deposit;
    const [refundedLogs, returnedLogs, listed] = await Promise.all([
      d.logs(dep, [encodeEventTopics({ abi: depositAbi, eventName: 'DepositRefunded' })[0] as Hex, null, null, me]),
      d.logs(dep, [encodeEventTopics({ abi: depositAbi, eventName: 'DepositReturned' })[0] as Hex, null, me]),
      d.explorer(dep).catch(() => [] as RawLog[]),
    ]);
    const mine = decodeCheckoutLogs([...refundedLogs, ...returnedLogs]);
    const paidEvents = decodeCheckoutLogs(listed).filter((e) => e.kind === 'paid');
    const ids = [...new Set([...mine.map((e) => e.id), ...paidEvents.map((e) => e.id)])].slice(0, d.maxDeposits ?? 100);
    for (const id of ids) {
      const [merchant, refundTo, amount, refunded, paidAt] = await view<readonly [Address, Address, bigint, bigint, bigint, number]>(d.call, dep, depositAbi, 'payment', [id]);
      if (!same(refundTo, customer) || amount === 0n) continue;
      const paid = paidEvents.find((e) => e.id === id);
      const refunds = await Promise.all(mine.filter((r) => r.kind === 'refunded' && r.id === id)
        .map(async (r) => ({ amount: (r as { amount: bigint }).amount, tx: r.tx, at: r.at ?? await timeOf(r.block) })));
      orders.push({ id, method: 'transfer', merchant, amount, refunded, net: amount - refunded, paidAt: paidAt ? Number(paidAt) * 1000 : null, tx: paid?.tx ?? null, refunds });
    }
  }

  orders.sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0));
  const paid = orders.reduce((t, o) => t + o.amount, 0n);
  const refunded = orders.reduce((t, o) => t + o.refunded, 0n);
  return { orders, subs, totals: { paid, refunded, net: paid - refunded } };
}
