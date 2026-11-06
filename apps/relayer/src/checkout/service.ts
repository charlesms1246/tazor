import { decodeErrorResult, encodeFunctionData, getAddress, isAddressEqual, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { BadRequest, UINT256_MAX, addr, hex, uint } from '../payment.ts';
import { SimulationFailed } from '../sender.ts';
import type { Webhooks } from '../webhooks.ts';
import { EXPLORER, USDT, checkoutAbi, usdtAbi, type Order, type Plan } from './abi.ts';

/** A state conflict found by the pre-checks (already paid, nonce used, not due…): HTTP 409. */
export class Conflict extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) { super(message); this.code = code; this.extra = extra; }
}

export type ChainLog = { transactionHash: Hex; blockNumber: bigint; args: Record<string, unknown> };
/** Whitechain access, injected so tests can fake it. `send` simulates first (SimulationFailed on a revert). */
export type CheckoutChain = {
  read<T = unknown>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<T>;
  logs(address: Address, event: AbiEvent, args: Record<string, unknown>, fromBlock: bigint): Promise<ChainLog[]>;
  block(tag: 'latest' | 'safe' | 'finalized' | bigint): Promise<{ number: bigint; timestamp: bigint }>;
  send(to: Address, data: Hex): Promise<Hex>;
  wait(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
};

export const MAX_WINDOW_SEC = 3600n;
const UINT64 = (1n << 64n) - 1n;
const ev = (name: string) => (checkoutAbi as readonly { type: string; name?: string }[]).find((x) => x.type === 'event' && x.name === name) as unknown as AbiEvent;
const txUrl = (h: Hex) => `${EXPLORER}/tx/${h}`;
const s = (v: bigint) => v.toString();

export type Stage = 'sequencer' | 'ethereum' | 'finalized';

export function createCheckout(o: {
  address: Address; chain: CheckoutChain; webhooks?: Webhooks; usdt?: Address; now?: () => number;
  /** The checkout contract's deploy block, so log scans start there. */
  fromBlock?: bigint;
  /** How far back the cron looks for Subscribed logs when fromBlock is unset. */
  lookback?: bigint;
}) {
  const C = getAddress(o.address);
  const usdt = o.usdt ?? USDT;
  const ch = o.chain;
  const nowSec = () => BigInt(Math.floor((o.now ?? Date.now)() / 1000));
  const seen = new Map<string, { stage: Stage; ethereumAt?: number; finalizedAt?: number }>();

  const window = (validAfter: bigint, validBefore: bigint) => {
    const now = nowSec();
    if (validAfter > now) throw new BadRequest('validAfter is in the future');
    if (validBefore <= now) throw new Conflict('expired', 'the signature has expired (validBefore)');
    if (validBefore - now > MAX_WINDOW_SEC) throw new BadRequest('validBefore must be within 1 hour');
  };
  const unused = async (who: Address, nonce: Hex) => {
    if (await ch.read<boolean>(usdt, usdtAbi, 'authorizationState', [who, nonce])) throw new Conflict('authorization-used', 'this signature was already used or cancelled');
  };
  const funded = async (who: Address, amount: bigint) => {
    const bal = await ch.read<bigint>(usdt, usdtAbi, 'balanceOf', [who]);
    if (bal < amount) throw new Conflict('insufficient-balance', `balance ${bal} is below ${amount}`, { balance: s(bal) });
  };
  /** Simulates (inside send), sends and waits for the receipt; a revert decodes the contract's custom error. */
  async function submit(data: Hex): Promise<{ txHash: Hex; blockNumber: bigint }> {
    let txHash: Hex;
    try { txHash = await ch.send(C, data); } catch (e) {
      if (e instanceof SimulationFailed) {
        const named = (checkoutAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === 'error').map((x) => x.name!).find((n) => e.message.includes(n));
        throw new SimulationFailed(named ? `${named}()` : e.message);
      }
      throw e;
    }
    const r = await ch.wait(txHash);
    if (r.status !== 'success') throw new SimulationFailed(`transaction ${txHash} reverted`);
    return { txHash, blockNumber: r.blockNumber };
  }
  /** 200 body: {ok, id, txHash, explorer, orderId|subId, …}. */
  const ok = (txHash: Hex, extra: Record<string, unknown> & { orderId?: Hex; subId?: Hex }) =>
    ({ ok: true as const, id: extra.orderId ?? extra.subId, txHash, explorer: txUrl(txHash), stage: 'sequencer' as const, ...extra });
  // ids and nonces straight from the contract's own views, so the relayer can never disagree with it
  const view = <T>(fn: string, args: readonly unknown[]) => ch.read<T>(C, checkoutAbi as unknown as Abi, fn, args);
  const emit = (e: Parameters<Webhooks['emit']>[0]) => (o.webhooks ? o.webhooks.emit(e).catch(() => null) : Promise.resolve(null));

  const payment = async (id: Hex) => {
    const [merchant, payer, amount, refunded, paidAt, refunds] = await ch.read<readonly [Address, Address, bigint, bigint, bigint, number]>(C, checkoutAbi as unknown as Abi, 'payment', [id]);
    return { merchant, payer, amount, refunded, paidAt: BigInt(paidAt), refunds: BigInt(refunds) };
  };
  const subscription = async (id: Hex) => {
    const [merchant, payer, amount, period, cycles, charged, start, active] = await ch.read<readonly [Address, Address, bigint, number, number, number, bigint, boolean]>(C, checkoutAbi as unknown as Abi, 'subscription', [id]);
    return { merchant, payer, amount, period: Number(period), cycles: Number(cycles), charged: Number(charged), start: BigInt(start), active };
  };

  // ---- parsing

  const parseOrder = (v: unknown): Order => {
    const x = (v ?? {}) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) throw new BadRequest('order must be an object');
    const order = { merchant: addr(x.merchant, 'order.merchant'), amount: uint(x.amount, 'order.amount', UINT256_MAX), ref: hex(x.ref, 'order.ref', 32), deadline: uint(x.deadline, 'order.deadline', UINT64) };
    if (order.amount === 0n) throw new BadRequest('order.amount must be positive');
    return order;
  };
  const parsePlan = (v: unknown): Plan => {
    const x = (v ?? {}) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) throw new BadRequest('plan must be an object');
    const plan = {
      merchant: addr(x.merchant, 'plan.merchant'), amount: uint(x.amount, 'plan.amount', UINT256_MAX),
      period: Number(uint(x.period, 'plan.period', 0xffffffffn)), cycles: Number(uint(x.cycles, 'plan.cycles', 0xffffn)), ref: hex(x.ref, 'plan.ref', 32),
    };
    if (plan.amount === 0n || plan.period === 0 || plan.cycles === 0) throw new BadRequest('plan amount, period and cycles must be positive');
    return plan;
  };
  const sig = (v: unknown, name = 'signature') => { const h = hex(v, name); if (h.length < 4) throw new BadRequest(`${name} must not be empty`); return h; };
  const body = (b: unknown) => { if (typeof b !== 'object' || b === null) throw new BadRequest('body must be a JSON object'); return b as Record<string, unknown>; };

  // ---- writes

  async function pay(raw: unknown) {
    const b = body(raw);
    const order = parseOrder(b.order);
    const payer = addr(b.payer, 'payer');
    const validAfter = uint(b.validAfter, 'validAfter', UINT256_MAX);
    const validBefore = uint(b.validBefore, 'validBefore', UINT256_MAX);
    const signature = sig(b.signature);
    const id = await view<Hex>('orderId', [order]);
    if (order.deadline <= nowSec()) throw new Conflict('expired', 'the order deadline has passed');
    window(validAfter, validBefore);
    if ((await payment(id)).paidAt !== 0n) throw new Conflict('already-paid', 'this order is already paid', { orderId: id });
    await unused(payer, await view<Hex>('payNonce', [order]));
    await funded(payer, order.amount);
    const r = await submit(encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [order, payer, validAfter, validBefore, signature] }));
    await emit({ id: `${id}:paid`, type: 'order.paid', merchant: order.merchant, txHash: r.txHash, data: { orderId: id, merchant: order.merchant, payer, amount: s(order.amount), ref: order.ref } });
    return ok(r.txHash, { orderId: id });
  }

  async function refund(raw: unknown) {
    const b = body(raw);
    const id = hex(b.id ?? b.orderId, 'id', 32);
    const amount = uint(b.amount, 'amount', UINT256_MAX);
    const validAfter = uint(b.validAfter, 'validAfter', UINT256_MAX);
    const validBefore = uint(b.validBefore, 'validBefore', UINT256_MAX);
    const signature = sig(b.signature);
    if (amount === 0n) throw new BadRequest('amount must be positive');
    window(validAfter, validBefore);
    const p = await payment(id);
    if (p.paidAt === 0n) throw new Conflict('not-paid', 'this order has not been paid');
    if (p.refunded + amount > p.amount) throw new Conflict('refund-too-large', `at most ${p.amount - p.refunded} can still be refunded`, { refundable: s(p.amount - p.refunded) });
    if (b.refundNo !== undefined && uint(b.refundNo, 'refundNo', 0xffffffffn) !== p.refunds) {
      throw new Conflict('stale-refund', `refund count changed, sign again (refundNo ${p.refunds})`, { refundNo: s(p.refunds) });
    }
    await unused(p.merchant, await view<Hex>('refundNonce', [id, amount, p.refunds]));
    await funded(p.merchant, amount);
    const r = await submit(encodeFunctionData({ abi: checkoutAbi, functionName: 'refund', args: [id, amount, validAfter, validBefore, signature] }));
    await emit({ id: `${id}:refund:${p.refunds}`, type: 'order.refunded', merchant: p.merchant, txHash: r.txHash, data: { orderId: id, merchant: p.merchant, payer: p.payer, amount: s(amount), totalRefunded: s(p.refunded + amount) } });
    return ok(r.txHash, { orderId: id });
  }

  async function subscribe(raw: unknown) {
    const flat = body(raw);
    // the struct form {first:{validAfter, validBefore, sig}, allowance:{validAfter: permitValue, validBefore: permitDeadline, sig}} also works
    const f = (flat.first ?? {}) as Record<string, unknown>;
    const al = (flat.allowance ?? {}) as Record<string, unknown>;
    const b: Record<string, unknown> = {
      ...flat,
      validAfter: flat.validAfter ?? f.validAfter, validBefore: flat.validBefore ?? f.validBefore, firstSig: flat.firstSig ?? f.sig,
      permitValue: flat.permitValue ?? al.validAfter, permitDeadline: flat.permitDeadline ?? al.validBefore, permitSig: flat.permitSig ?? al.sig,
    };
    const plan = parsePlan(b.plan);
    const payer = addr(b.payer, 'payer');
    const validAfter = uint(b.validAfter, 'validAfter', UINT256_MAX);
    const validBefore = uint(b.validBefore, 'validBefore', UINT256_MAX);
    const firstSig = sig(b.firstSig, 'firstSig');
    // the later pulls ride on a USDT permit; an empty sig skips it (single-cycle plans, or an existing allowance)
    const permitValue = b.permitValue === undefined ? 0n : uint(b.permitValue, 'permitValue', UINT256_MAX);
    const permitDeadline = b.permitDeadline === undefined ? 0n : uint(b.permitDeadline, 'permitDeadline', UINT256_MAX);
    const permitSig = typeof b.permitSig === 'string' && b.permitSig !== '' ? hex(b.permitSig, 'permitSig') : '0x';
    if (plan.cycles > 1 && permitSig === '0x') throw new BadRequest('permitSig is required for plans with more than one cycle');
    window(validAfter, validBefore);
    const id = await view<Hex>('subId', [plan, payer]);
    if ((await subscription(id)).start !== 0n) throw new Conflict('exists', 'this subscription already exists', { subId: id });
    await unused(payer, await view<Hex>('subNonce', [plan, payer]));
    await funded(payer, plan.amount);
    const first = { validAfter, validBefore, sig: firstSig };
    const allowance = { validAfter: permitValue, validBefore: permitDeadline, sig: permitSig as Hex };
    const r = await submit(encodeFunctionData({ abi: checkoutAbi, functionName: 'subscribe', args: [plan, payer, first, allowance] }));
    const data = { subId: id, merchant: plan.merchant, payer, amount: s(plan.amount), period: plan.period, cycles: plan.cycles, ref: plan.ref };
    await emit({ id: `${id}:created`, type: 'subscription.created', merchant: plan.merchant, txHash: r.txHash, data });
    await emit({ id: `${id}:charged:1`, type: 'subscription.charged', merchant: plan.merchant, txHash: r.txHash, data: { ...data, cycle: 1 } });
    return ok(r.txHash, { subId: id });
  }

  async function cancel(raw: unknown) {
    const b = body(raw);
    const id = hex(b.subId ?? b.id, 'subId', 32);
    const signature = sig(b.signature);
    const sub = await subscription(id);
    if (sub.start === 0n || !sub.active) throw new Conflict('not-active', 'this subscription is not active');
    // the signer must be the payer or the merchant (the contract checks the signature against `by`)
    const by = b.by ?? b.signer;
    const signer = by === undefined ? sub.payer : addr(by, 'signer');
    if (!isAddressEqual(signer, sub.payer) && !isAddressEqual(signer, sub.merchant)) throw new Conflict('not-party', 'only the payer or the merchant can cancel');
    const r = await submit(encodeFunctionData({ abi: checkoutAbi, functionName: 'cancelBySig', args: [id, signer, signature] }));
    await emit({ id: `${id}:cancelled`, type: 'subscription.cancelled', merchant: sub.merchant, txHash: r.txHash, data: { subId: id, merchant: sub.merchant, payer: sub.payer } });
    return ok(r.txHash, { subId: id });
  }

  /** Charges one due cycle; anyone may trigger it. */
  async function charge(raw: unknown) {
    const b = body(raw);
    return chargeId(hex(b.subId ?? b.id, 'subId', 32));
  }
  async function chargeId(id: Hex) {
    const next = BigInt(await ch.read<bigint>(C, checkoutAbi as unknown as Abi, 'nextChargeAt', [id]));
    if (next === 0n) throw new Conflict('not-active', 'this subscription is finished or cancelled');
    if (next > nowSec()) throw new Conflict('not-due', 'the next charge is not due yet', { nextChargeAt: s(next) });
    const sub = await subscription(id);
    await funded(sub.payer, sub.amount);
    const r = await submit(encodeFunctionData({ abi: checkoutAbi, functionName: 'charge', args: [id] }));
    const cycle = sub.charged + 1;
    await emit({ id: `${id}:charged:${cycle}`, type: 'subscription.charged', merchant: sub.merchant, txHash: r.txHash, data: { subId: id, merchant: sub.merchant, payer: sub.payer, amount: s(sub.amount), cycle } });
    return ok(r.txHash, { subId: id, cycle });
  }

  // ---- reads

  const fromBlock = async () => o.fromBlock ?? (await ch.block('latest')).number - (o.lookback ?? 500_000n);
  const clampFrom = async () => { const f = await fromBlock(); return f < 0n ? 0n : f; };

  /** The order's payment, its refunds, and how final the payment is (sequencer → posted to Ethereum → finalized). */
  async function order(idRaw: string) {
    const id = hex(idRaw, 'id', 32);
    const p = await payment(id);
    if (p.paidAt === 0n) return { id, orderId: id, status: 'unpaid' as const, stage: null };
    const from = await clampFrom();
    const [paid, refunds] = await Promise.all([
      ch.logs(C, ev('OrderPaid'), { id }, from),
      ch.logs(C, ev('Refunded'), { id }, from),
    ]);
    const payLog = paid[0];
    let stage: Stage | null = null;
    let sequencerAt: number | null = null;
    if (payLog) {
      const [safe, finalized, blk] = await Promise.all([ch.block('safe'), ch.block('finalized'), ch.block(payLog.blockNumber)]);
      stage = payLog.blockNumber <= finalized.number ? 'finalized' : payLog.blockNumber <= safe.number ? 'ethereum' : 'sequencer';
      sequencerAt = Number(blk.timestamp);
    }
    const prev = seen.get(id);
    const nowS = Number(nowSec());
    const rec = { stage: stage ?? 'sequencer', ethereumAt: prev?.ethereumAt, finalizedAt: prev?.finalizedAt };
    if (stage === 'ethereum' || stage === 'finalized') rec.ethereumAt ??= nowS;
    if (stage === 'finalized') rec.finalizedAt ??= nowS;
    seen.set(id, rec);
    if (stage && prev?.stage !== stage) {
      await emit({ id: `${id}:${stage}`, type: 'order.finality', merchant: p.merchant, txHash: payLog?.transactionHash ?? null, data: { orderId: id, stage, block: payLog ? s(payLog.blockNumber) : null } });
    }
    return {
      id, orderId: id, status: p.refunded === 0n ? 'paid' : p.refunded >= p.amount ? 'refunded' : 'partially-refunded',
      merchant: p.merchant, payer: p.payer, amount: s(p.amount), refunded: s(p.refunded), paidAt: s(p.paidAt), refunds: Number(p.refunds),
      payTx: payLog?.transactionHash ?? null, txHash: payLog?.transactionHash ?? null, payBlock: payLog ? s(payLog.blockNumber) : null, stage,
      stages: {
        sequencer: { block: payLog ? s(payLog.blockNumber) : null, at: sequencerAt },
        ethereum: { at: rec.ethereumAt ?? null }, finalized: { at: rec.finalizedAt ?? null },
      },
      refundTxs: refunds.map((l) => ({ tx: l.transactionHash, amount: String(l.args.amount), totalRefunded: String(l.args.totalRefunded), block: s(l.blockNumber) })),
      explorer: payLog ? txUrl(payLog.transactionHash) : null,
    };
  }

  async function subscriptionView(idRaw: string) {
    const id = hex(idRaw, 'id', 32);
    const sub = await subscription(id);
    if (sub.start === 0n) return { id, subId: id, status: 'unknown' as const };
    const next = BigInt(await ch.read<bigint>(C, checkoutAbi as unknown as Abi, 'nextChargeAt', [id]));
    const from = await clampFrom();
    const [charges, cancels] = await Promise.all([ch.logs(C, ev('Charged'), { id }, from), ch.logs(C, ev('Cancelled'), { id }, from)]);
    return {
      id, subId: id, merchant: sub.merchant, payer: sub.payer, amount: s(sub.amount), period: sub.period, cycles: sub.cycles, charged: sub.charged,
      start: s(sub.start), active: sub.active, nextChargeAt: s(next), due: next !== 0n && next <= nowSec(),
      charges: charges.map((l) => ({ tx: l.transactionHash, cycle: Number(l.args.cycle), amount: String(l.args.amount), block: s(l.blockNumber) })),
      ...(cancels[0] ? { cancelledBy: cancels[0].args.by as Address } : {}),
    };
  }

  /**
   * Cron pass: every subscription seen in Subscribed logs is charged when due, and gets one subscription.due
   * webhook in the 24 h before its next charge. `guard` runs before each charge (gas budget, balance floor).
   */
  async function scanDue(guard?: (subId: Hex) => Promise<void>) {
    const subs = await ch.logs(C, ev('Subscribed'), {}, await clampFrom());
    const ids = [...new Set(subs.map((l) => l.args.id as Hex))];
    const now = nowSec();
    const results: { subId: Hex; action: 'charged' | 'reminded' | 'skipped' | 'error'; detail?: string; txHash?: Hex }[] = [];
    for (const id of ids) {
      try {
        const next = BigInt(await ch.read<bigint>(C, checkoutAbi as unknown as Abi, 'nextChargeAt', [id]));
        if (next === 0n) { results.push({ subId: id, action: 'skipped', detail: 'finished or cancelled' }); continue; }
        if (next <= now) {
          await guard?.(id);
          const r = await chargeId(id);
          results.push({ subId: id, action: 'charged', txHash: r.txHash });
        } else if (next - now <= 86_400n) {
          const sub = await subscription(id);
          const d = await emit({ id: `${id}:due:${next}`, type: 'subscription.due', merchant: sub.merchant, data: { subId: id, merchant: sub.merchant, payer: sub.payer, amount: s(sub.amount), nextChargeAt: s(next) } });
          results.push({ subId: id, action: d ? 'reminded' : 'skipped', detail: d ? undefined : 'reminder already sent' });
        } else results.push({ subId: id, action: 'skipped', detail: 'not due within 24 h' });
      } catch (e) {
        results.push({ subId: id, action: 'error', detail: e instanceof Error ? e.message.split('\n')[0] : String(e) });
      }
    }
    return { subscriptions: ids.length, results };
  }

  return { address: C, pay, refund, subscribe, cancel, charge, order, subscription: subscriptionView, scanDue };
}
export type Checkout = ReturnType<typeof createCheckout>;

/** Reads a revert's custom error name if the data decodes against the checkout ABI. */
export const checkoutError = (data: Hex) => { try { return decodeErrorResult({ abi: checkoutAbi, data }).errorName; } catch { return null; } };
export { isAddressEqual, zeroAddress };
