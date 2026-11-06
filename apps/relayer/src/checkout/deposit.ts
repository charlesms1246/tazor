import { encodeFunctionData, getAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { BadRequest, UINT256_MAX, addr, hex, uint } from '../payment.ts';
import { SimulationFailed } from '../sender.ts';
import type { Webhooks } from '../webhooks.ts';
import { emitReady, shipView } from './ship.ts';
import { EXPLORER, USDT, usdtAbi } from './abi.ts';
import { depositAbi } from './deposit-abi.ts';
import { Conflict, MAX_WINDOW_SEC, type CheckoutChain, type Stage } from './service.ts';

export type DepositOrder = { merchant: Address; amount: bigint; ref: Hex; deadline: bigint; refundTo: Address };
const UINT64 = (1n << 64n) - 1n;
const abi = depositAbi as unknown as Abi;
const ev = (name: string) => (depositAbi as readonly { type: string; name?: string }[]).find((x) => x.type === 'event' && x.name === name) as unknown as AbiEvent;
const txUrl = (h: Hex) => `${EXPLORER}/tx/${h}`;

export function parseDepositOrder(v: unknown): DepositOrder {
  if (typeof v !== 'object' || v === null) throw new BadRequest('order must be an object');
  const x = v as Record<string, unknown>;
  const o = {
    merchant: addr(x.merchant, 'order.merchant'), amount: uint(x.amount, 'order.amount', UINT256_MAX), ref: hex(x.ref, 'order.ref', 32),
    deadline: uint(x.deadline, 'order.deadline', UINT64), refundTo: addr(x.refundTo, 'order.refundTo'),
  };
  if (o.amount === 0n) throw new BadRequest('order.amount must be positive');
  return o;
}

/** `?order=` is base64url JSON of the DepositOrder (so the customer's page can poll with just a link). */
export function orderFromQuery(q: string | null): DepositOrder {
  if (!q) throw new BadRequest('order is required (base64url JSON of {merchant, amount, ref, deadline, refundTo})');
  let json: unknown;
  try { json = JSON.parse(Buffer.from(q, 'base64url').toString('utf8')); } catch { throw new BadRequest('order must be base64url JSON'); }
  return parseDepositOrder(json);
}

/**
 * Pay by plain transfer: the customer sends USDT (from any wallet or exchange withdrawal) to the order's deposit
 * address; the relayer settles once the balance covers the amount. Polling the status settles it too, so the
 * merchant needs no server.
 */
export function createDeposit(o: {
  address: Address; chain: CheckoutChain; webhooks?: Webhooks; usdt?: Address; now?: () => number; fromBlock?: bigint;
}) {
  const D = getAddress(o.address);
  const usdt = o.usdt ?? USDT;
  const ch = o.chain;
  const nowSec = () => BigInt(Math.floor((o.now ?? Date.now)() / 1000));
  const view = <T>(fn: string, args: readonly unknown[]) => ch.read<T>(D, abi, fn, args);
  const settling = new Map<string, Promise<{ txHash: Hex }>>();
  const seen = new Map<string, Stage>();
  const emit = (e: Parameters<Webhooks['emit']>[0]) => (o.webhooks ? o.webhooks.emit(e).catch(() => null) : Promise.resolve(null));

  const payment = async (id: Hex) => {
    const [merchant, refundTo, amount, refunded, paidAt, refunds] = await view<readonly [Address, Address, bigint, bigint, bigint, number]>('payment', [id]);
    return { merchant, refundTo, amount, refunded, paidAt: BigInt(paidAt), refunds: BigInt(refunds) };
  };

  async function send(data: Hex): Promise<Hex> {
    let tx: Hex;
    try { tx = await ch.send(D, data); } catch (e) {
      if (e instanceof SimulationFailed) {
        const named = (depositAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === 'error').map((x) => x.name!).find((n) => e.message.includes(n));
        throw new SimulationFailed(named ? `${named}()` : e.message);
      }
      throw e;
    }
    const r = await ch.wait(tx);
    if (r.status !== 'success') throw new SimulationFailed(`transaction ${tx} reverted`);
    return tx;
  }

  /** settle(order), once per order id per instance at a time; emits order.paid (source "deposit"). */
  function settleOnce(order: DepositOrder, id: Hex, balance: bigint): Promise<{ txHash: Hex }> {
    const running = settling.get(id);
    if (running) return running;
    const run = (async () => {
      const txHash = await send(encodeFunctionData({ abi, functionName: 'settle', args: [order] }));
      await emit({
        id: `${id}:paid`, type: 'order.paid', merchant: order.merchant, txHash,
        data: { orderId: id, source: 'deposit', merchant: order.merchant, refundTo: order.refundTo, amount: order.amount.toString(), received: balance.toString(), ref: order.ref, ...(({ ready, waitFor, shipAbove }) => ({ ready, waitFor, shipAbove }))(shipView(o.webhooks, order.merchant, order.amount, 'sequencer')) },
      });
      await emitReady(o.webhooks, { orderId: id, merchant: order.merchant, amount: order.amount, stage: 'sequencer', txHash, source: 'deposit' });
      return { txHash };
    })().finally(() => settling.delete(id));
    settling.set(id, run);
    return run;
  }

  const stageOf = async (block: bigint): Promise<Stage> => {
    const [safe, finalized] = await Promise.all([ch.block('safe'), ch.block('finalized')]);
    return block <= finalized.number ? 'finalized' : block <= safe.number ? 'ethereum' : 'sequencer';
  };

  async function readState(order: DepositOrder) {
    const [id, depositAddress] = await Promise.all([view<Hex>('orderId', [order]), view<Address>('depositAddress', [order])]);
    const [balance, p] = await Promise.all([ch.read<bigint>(usdt, usdtAbi as unknown as Abi, 'balanceOf', [depositAddress]), payment(id)]);
    return { id, depositAddress, balance, p };
  }

  async function settle(raw: unknown, guard?: (order: DepositOrder) => Promise<void>) {
    const order = parseDepositOrder((raw as { order?: unknown } | null)?.order);
    const { id, balance, p } = await readState(order);
    if (p.paidAt !== 0n) throw new Conflict('already-paid', 'this order is already paid', { orderId: id });
    if (order.deadline <= nowSec()) throw new Conflict('expired', 'the order deadline has passed; the customer can get the funds back with returnFunds');
    if (balance < order.amount) throw new Conflict('underpaid', `the deposit address holds ${balance}, the order needs ${order.amount}`, { balance: balance.toString() });
    await guard?.(order);
    const { txHash } = await settleOnce(order, id, balance);
    return { ok: true as const, id, orderId: id, txHash, explorer: txUrl(txHash), stage: 'sequencer' as const };
  }

  /** The deposit address, what it holds and the payment state; a funded unpaid order is settled on the spot (guarded). */
  async function status(order: DepositOrder, guard?: (order: DepositOrder) => Promise<void>) {
    let { id, depositAddress, balance, p } = await readState(order);
    let settledNow: Hex | null = null;
    let settleError: string | null = null;
    if (p.paidAt === 0n && balance >= order.amount && order.deadline > nowSec()) {
      try {
        await guard?.(order);
        settledNow = (await settleOnce(order, id, balance)).txHash;
        ({ balance, p } = await readState(order));
      } catch (e) {
        // a concurrent settle won the race, or the guard refused: report state, never fail the poll
        settleError = e instanceof Error ? e.message.split('\n')[0] : String(e);
      }
    }
    const paid = p.paidAt !== 0n;
    let payTx: Hex | null = settledNow;
    let stage: Stage | null = null;
    if (paid) {
      const logs = await ch.logs(D, ev('DepositPaid'), { id }, o.fromBlock ?? 0n).catch(() => []);
      const log = logs[0];
      payTx = log?.transactionHash ?? settledNow;
      stage = log ? await stageOf(log.blockNumber) : 'sequencer';
      if (seen.get(id) !== stage) {
        seen.set(id, stage);
        await emit({ id: `${id}:${stage}`, type: 'order.finality', merchant: order.merchant, txHash: payTx, data: { orderId: id, source: 'deposit', stage } });
      }
    }
    const ship = paid ? await emitReady(o.webhooks, { orderId: id, merchant: order.merchant, amount: order.amount, stage, txHash: payTx, source: 'deposit' }) : shipView(o.webhooks, order.merchant, order.amount, null);
    return {
      id, orderId: id, depositAddress, balance: balance.toString(), amount: order.amount.toString(),
      status: !paid ? (balance >= order.amount ? 'funded' : balance > 0n ? 'underpaid' : 'awaiting-transfer') : p.refunded === 0n ? 'paid' : p.refunded >= p.amount ? 'refunded' : 'partially-refunded',
      paid, paidAt: p.paidAt.toString(), refunded: p.refunded.toString(), deadline: order.deadline.toString(), expired: order.deadline <= nowSec(),
      payTx, txHash: payTx, explorer: payTx ? txUrl(payTx) : null, stage,
      ship: { ready: ship.ready, waitFor: ship.waitFor, shipAbove: ship.shipAbove, reason: ship.reason }, ...(settledNow ? { settledNow } : {}), ...(settleError ? { settleError } : {}),
    };
  }

  async function refund(raw: unknown) {
    if (typeof raw !== 'object' || raw === null) throw new BadRequest('body must be a JSON object');
    const b = raw as Record<string, unknown>;
    const id = hex(b.id ?? b.orderId, 'id', 32);
    const amount = uint(b.amount, 'amount', UINT256_MAX);
    const validAfter = uint(b.validAfter, 'validAfter', UINT256_MAX);
    const validBefore = uint(b.validBefore, 'validBefore', UINT256_MAX);
    const signature = hex(b.signature, 'signature');
    if (amount === 0n || signature.length < 4) throw new BadRequest('amount and signature are required');
    const now = nowSec();
    if (validAfter > now) throw new BadRequest('validAfter is in the future');
    if (validBefore <= now) throw new Conflict('expired', 'the signature has expired (validBefore)');
    if (validBefore - now > MAX_WINDOW_SEC) throw new BadRequest('validBefore must be within 1 hour');
    const p = await payment(id);
    if (p.paidAt === 0n) throw new Conflict('not-paid', 'this order has not been paid');
    if (p.refunded + amount > p.amount) throw new Conflict('refund-too-large', `at most ${p.amount - p.refunded} can still be refunded`, { refundable: (p.amount - p.refunded).toString() });
    if (b.refundNo !== undefined && uint(b.refundNo, 'refundNo', 0xffffffffn) !== p.refunds) {
      throw new Conflict('stale-refund', `refund count changed, sign again (refundNo ${p.refunds})`, { refundNo: p.refunds.toString() });
    }
    if (await ch.read<boolean>(usdt, usdtAbi as unknown as Abi, 'authorizationState', [p.merchant, await view<Hex>('refundNonce', [id, amount, p.refunds])])) {
      throw new Conflict('authorization-used', 'this signature was already used or cancelled');
    }
    if ((await ch.read<bigint>(usdt, usdtAbi as unknown as Abi, 'balanceOf', [p.merchant])) < amount) throw new Conflict('insufficient-balance', 'the merchant balance is below the refund');
    const txHash = await send(encodeFunctionData({ abi, functionName: 'refund', args: [id, amount, validAfter, validBefore, signature] }));
    await emit({ id: `${id}:refund:${p.refunds}`, type: 'order.refunded', merchant: p.merchant, txHash, data: { orderId: id, source: 'deposit', merchant: p.merchant, refundTo: p.refundTo, amount: amount.toString(), totalRefunded: (p.refunded + amount).toString() } });
    return { ok: true as const, id, orderId: id, txHash, explorer: txUrl(txHash), stage: 'sequencer' as const };
  }

  return { address: D, settle, status, refund };
}
export type Deposit = ReturnType<typeof createDeposit>;
