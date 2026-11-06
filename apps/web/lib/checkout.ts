/**
 * TazorCheckout (pay by signing an EIP-3009 authorisation) and TazorDepositCheckout (pay by a plain transfer to a per-order
 * address) on Whitechain: formulas, typed data, wallet signing, relayer calls, and readers that use only Whitechain (RPC,
 * with the public explorer as a fallback for logs) so receipts work with Tazor's relayer down.
 * The formulas mirror packages/pay/src/checkout.ts exactly (a unit test compares them byte for byte); they live here too
 * because the web build only compiles files inside apps/web.
 */
import {
  decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToBytes, toHex,
  type Address, type Hex,
} from 'viem';
import { config } from './config.ts';
import { rpc } from './rpc.ts';

export const USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
export const ZERO: Address = '0x0000000000000000000000000000000000000000';
const live = (a: Address | null | undefined) => (a && a !== ZERO ? a : null);
export const checkoutAddress = (): Address | null => live(config.checkout);
export const depositCheckoutAddress = (): Address | null => live(config.depositCheckout);
/** Block TazorCheckout was deployed at (TazorDepositCheckout came later): log queries start here. */
export const CHECKOUT_DEPLOY_BLOCK = 12_391_780;

export const checkoutAbi = parseAbi([
  'event OrderPaid(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, bytes32 ref)',
  'event Refunded(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint256 totalRefunded)',
  'event Subscribed(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint32 period, uint16 cycles, bytes32 ref)',
  'event Charged(bytes32 indexed id, uint16 cycle, uint256 amount)',
  'event Cancelled(bytes32 indexed id, address by)',
  'function payment(bytes32 id) view returns (address merchant, address payer, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)',
  'function subscription(bytes32 id) view returns (address merchant, address payer, uint256 amount, uint32 period, uint16 cycles, uint16 charged, uint64 start, bool active)',
  'function nextChargeAt(bytes32 id) view returns (uint64)',
]);
export const depositAbi = parseAbi([
  'event DepositPaid(bytes32 indexed id, address indexed merchant, address indexed vault, uint256 amount, uint256 excess, bytes32 ref)',
  'event DepositRefunded(bytes32 indexed id, address indexed merchant, address indexed refundTo, uint256 amount, uint256 totalRefunded)',
  'event DepositReturned(bytes32 indexed id, address indexed refundTo, uint256 amount)',
  'function payment(bytes32 id) view returns (address merchant, address refundTo, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)',
]);

// ---- formulas (as the contracts compute them)

export type Order = { merchant: Address; amount: bigint; ref: Hex; deadline: bigint };
export type Plan = { merchant: Address; amount: bigint; period: number; cycles: number; ref: Hex };
const tag = (s: string) => keccak256(stringToBytes(s));

export const orderRef = (orderNumber: string): Hex => keccak256(stringToBytes(orderNumber));
export const orderId = (o: Order, checkout: Address, chainId = config.chainId): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [BigInt(chainId), checkout, o.merchant, o.ref]));
export const payNonce = (o: Order, checkout: Address, chainId = config.chainId): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
    [tag('tazor.checkout.pay'), orderId(o, checkout, chainId), o.amount, o.deadline]));
/** `deposit` = TazorDepositCheckout's refunds, which use their own tag. */
export const refundNonce = (id: Hex, amount: bigint, refundNo: bigint | number, deposit = false): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
    [tag(deposit ? 'tazor.deposit.refund' : 'tazor.checkout.refund'), id, amount, BigInt(refundNo)]));
const PLAN_T = { type: 'tuple', components: [
  { name: 'merchant', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'period', type: 'uint32' },
  { name: 'cycles', type: 'uint16' }, { name: 'ref', type: 'bytes32' },
] } as const;
export const subId = (p: Plan, payer: Address, checkout: Address, chainId = config.chainId): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, PLAN_T, { type: 'address' }], [BigInt(chainId), checkout, p, payer]));
export const subNonce = (p: Plan, payer: Address, checkout: Address, chainId = config.chainId): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [tag('tazor.checkout.subscribe'), subId(p, payer, checkout, chainId)]));

export type TypedData = { domain: { name: string; version: string; chainId: number; verifyingContract: Address }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
const AUTH_FIELDS = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
];
/** validAfter 0, validBefore within the relayer's one-hour window. */
export const window1h = (now = Math.floor(Date.now() / 1000)) => ({ validAfter: 0n, validBefore: BigInt(now + 3500) });

/** The merchant's refund: an EIP-3009 ReceiveWithAuthorization to the contract that holds the order, on the USDT domain. */
export function refundTypedData(id: Hex, merchant: Address, amount: bigint, refundNo: bigint | number,
  o: { checkout: Address; deposit?: boolean; validAfter?: bigint; validBefore?: bigint; chainId?: number }): TypedData {
  const w = window1h();
  return {
    domain: { name: 'Tether USD', version: '1', chainId: o.chainId ?? config.chainId, verifyingContract: USDT },
    types: { ReceiveWithAuthorization: AUTH_FIELDS },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: merchant, to: o.checkout, value: amount, validAfter: o.validAfter ?? w.validAfter, validBefore: o.validBefore ?? w.validBefore, nonce: refundNonce(id, amount, refundNo, o.deposit) },
  };
}
/** Cancel(bytes32 subId) on the TazorCheckout domain, signed by the payer or the merchant. */
export const cancelTypedData = (sub: Hex, checkout: Address, chainId = config.chainId): TypedData => ({
  domain: { name: 'TazorCheckout', version: '1', chainId, verifyingContract: checkout },
  types: { Cancel: [{ name: 'subId', type: 'bytes32' }] },
  primaryType: 'Cancel',
  message: { subId: sub },
});

// ---- signing with the browser wallet

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export type Signer = { address: Address; signTypedData(td: TypedData): Promise<Hex> };

/** eth_signTypedData_v4 JSON (EIP712Domain added, bigints as decimal strings). */
export const toEip712Json = (td: TypedData) => JSON.stringify({
  domain: td.domain,
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...td.types },
  primaryType: td.primaryType,
  message: td.message,
}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

async function onWhitechain(eth: Eip1193) {
  const chainId = `0x${config.chainId.toString(16)}`;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: [config.rpcUrl], blockExplorerUrls: [config.explorer] }] });
  }
}

export async function walletSigner(eth: Eip1193): Promise<Signer> {
  const [first] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!first) throw new Error('The wallet did not share an account.');
  const address = getAddress(first);
  return {
    address,
    async signTypedData(td) {
      await onWhitechain(eth).catch(() => undefined);
      return (await eth.request({ method: 'eth_signTypedData_v4', params: [address, toEip712Json(td)] })) as Hex;
    },
  };
}

// ---- relayer calls (the merchant signs, the relayer submits and pays the gas)

type Relay = { relayer: string; fetch?: typeof fetch };
async function post<T>(o: Relay, path: string, body: unknown): Promise<T> {
  if (!o.relayer) throw new Error('No relayer is set on this device (Security & settings).');
  const res = await (o.fetch ?? fetch)(`${o.relayer.replace(/\/+$/, '')}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new Error(j.code === 'stale-refund' ? 'Another refund landed first; press Refund again to sign the new one.' : j.error ?? `relayer returned ${res.status}`);
  return j;
}
export type Submitted = { txHash: Hex; explorer?: string };

/** Refund (all or part) to the original payer; signed by the merchant's wallet. */
export async function refundOrder(a: { id: Hex; amount: bigint; wallet: Signer; method: PayMethod } & Relay): Promise<Submitted> {
  const contract = a.method === 'transfer' ? depositCheckoutAddress() : checkoutAddress();
  if (!contract) throw new Error('This checkout contract is not configured.');
  const p = await readPayment(a.id);
  if (!p) throw new Error('This order is not paid.');
  const td = refundTypedData(a.id, a.wallet.address, a.amount, p.refunds, { checkout: contract, deposit: a.method === 'transfer' });
  const signature = await a.wallet.signTypedData(td);
  return post<Submitted>(a, a.method === 'transfer' ? '/checkout/deposit/refund' : '/checkout/refund', {
    id: a.id, amount: a.amount, refundNo: p.refunds, validAfter: td.message.validAfter, validBefore: td.message.validBefore, signature,
  });
}
export const chargeSubscription = (a: { id: Hex } & Relay) => post<Submitted>(a, '/checkout/charge', { id: a.id, subId: a.id });
export async function cancelSubscription(a: { id: Hex; wallet: Signer } & Relay): Promise<Submitted> {
  const contract = checkoutAddress();
  if (!contract) throw new Error('Checkout is not configured.');
  const signature = await a.wallet.signTypedData(cancelTypedData(a.id, contract));
  return post<Submitted>(a, '/checkout/cancel', { id: a.id, subId: a.id, by: a.wallet.address, signer: a.wallet.address, signature });
}

// ---- reading the chain

/** How the customer paid: signed an authorisation in their wallet, or sent a plain transfer (e.g. from an exchange). */
export type PayMethod = 'signed' | 'transfer';
/** For a transfer, `payer` is where refunds go (refundTo). */
export type Payment = { method: PayMethod; contract: Address; merchant: Address; payer: Address; amount: bigint; refunded: bigint; paidAt: number; refunds: number };

async function paymentOn(abi: typeof checkoutAbi | typeof depositAbi, contract: Address, id: Hex) {
  const data = await rpc<Hex>('eth_call', [{ to: contract, data: encodeFunctionData({ abi, functionName: 'payment', args: [id] } as never) }, 'latest']);
  return decodeFunctionResult({ abi, functionName: 'payment', data } as never) as unknown as readonly [Address, Address, bigint, bigint, bigint, number];
}

/** The order's payment: TazorCheckout first, then TazorDepositCheckout; null when neither has it. */
export async function readPayment(id: Hex): Promise<Payment | null> {
  const sources: [PayMethod, Address | null, typeof checkoutAbi | typeof depositAbi][] = [
    ['signed', checkoutAddress(), checkoutAbi], ['transfer', depositCheckoutAddress(), depositAbi],
  ];
  for (const [method, contract, abi] of sources) {
    if (!contract) continue;
    const [merchant, payer, amount, refunded, paidAt, refunds] = await paymentOn(abi, contract, id);
    if (merchant !== ZERO) return { method, contract, merchant, payer, amount, refunded, paidAt: Number(paidAt), refunds: Number(refunds) };
  }
  return null;
}

export type RawLog = { address?: string; topics: (Hex | null)[]; data: Hex; blockNumber: Hex | number; transactionHash: Hex; logIndex?: Hex | number; block_timestamp?: string };
type Base = { id: Hex; block: number; logIndex?: number; tx: Hex; at?: number };
/** Chain order: block, then position in the block. */
const byChain = (x: Base, y: Base) => x.block - y.block || (x.logIndex ?? 0) - (y.logIndex ?? 0);
export type CheckoutEvent =
  | (Base & { kind: 'paid'; method: PayMethod; merchant: Address; payer: Address; amount: bigint; ref: Hex; excess?: bigint })
  | (Base & { kind: 'refunded'; merchant: Address; payer: Address; amount: bigint; totalRefunded: bigint })
  | (Base & { kind: 'returned'; payer: Address; amount: bigint })
  | (Base & { kind: 'subscribed'; merchant: Address; payer: Address; amount: bigint; period: number; cycles: number; ref: Hex })
  | (Base & { kind: 'charged'; cycle: number; amount: bigint })
  | (Base & { kind: 'cancelled'; by: Address });

const num = (v: Hex | number) => (typeof v === 'number' ? v : Number(BigInt(v)));
const ALL = [...checkoutAbi, ...depositAbi];

/** Decodes both contracts' logs (RPC or Blockscout shape); unknown logs are skipped. Oldest first. */
export function decodeCheckoutLogs(logs: RawLog[]): CheckoutEvent[] {
  const out: CheckoutEvent[] = [];
  for (const l of logs) {
    const topics = l.topics.filter((t): t is Hex => !!t);
    if (!topics.length) continue;
    try {
      const ev = decodeEventLog({ abi: ALL, data: l.data, topics: topics as [Hex, ...Hex[]] });
      const a = ev.args as Record<string, unknown>;
      const base: Base = { id: (a.id as Hex).toLowerCase() as Hex, block: num(l.blockNumber), logIndex: l.logIndex === undefined ? undefined : num(l.logIndex), tx: l.transactionHash, at: l.block_timestamp ? Date.parse(l.block_timestamp) : undefined };
      switch (ev.eventName) {
        case 'OrderPaid': out.push({ ...base, kind: 'paid', method: 'signed', merchant: a.merchant as Address, payer: a.payer as Address, amount: a.amount as bigint, ref: a.ref as Hex }); break;
        case 'DepositPaid': out.push({ ...base, kind: 'paid', method: 'transfer', merchant: a.merchant as Address, payer: a.vault as Address, amount: a.amount as bigint, ref: a.ref as Hex, excess: a.excess as bigint }); break;
        case 'Refunded': out.push({ ...base, kind: 'refunded', merchant: a.merchant as Address, payer: a.payer as Address, amount: a.amount as bigint, totalRefunded: a.totalRefunded as bigint }); break;
        case 'DepositRefunded': out.push({ ...base, kind: 'refunded', merchant: a.merchant as Address, payer: a.refundTo as Address, amount: a.amount as bigint, totalRefunded: a.totalRefunded as bigint }); break;
        case 'DepositReturned': out.push({ ...base, kind: 'returned', payer: a.refundTo as Address, amount: a.amount as bigint }); break;
        case 'Subscribed': out.push({ ...base, kind: 'subscribed', merchant: a.merchant as Address, payer: a.payer as Address, amount: a.amount as bigint, period: Number(a.period), cycles: Number(a.cycles), ref: a.ref as Hex }); break;
        case 'Charged': out.push({ ...base, kind: 'charged', cycle: Number(a.cycle), amount: a.amount as bigint }); break;
        case 'Cancelled': out.push({ ...base, kind: 'cancelled', by: a.by as Address }); break;
      }
    } catch { /* another contract's event */ }
  }
  return out.sort(byChain);
}

const BLOCKSCOUT = 'https://explorer.testnet.whitechain.io/api/v2';
/** Up to `pages` pages of a contract's logs from the public explorer. */
export async function explorerLogs(contract: Address, pages = 4, f: typeof fetch = fetch): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let query = '';
  for (let i = 0; i < pages; i++) {
    const res = await f(`${BLOCKSCOUT}/addresses/${contract}/logs${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`explorer returned ${res.status}`);
    const body = (await res.json()) as { items?: { topics: (Hex | null)[]; data: Hex; block_number: number; transaction_hash: Hex; index: number; block_timestamp: string }[]; next_page_params?: Record<string, unknown> | null };
    for (const it of body.items ?? []) out.push({ topics: it.topics, data: it.data, blockNumber: it.block_number, transactionHash: it.transaction_hash, logIndex: it.index, block_timestamp: it.block_timestamp });
    if (!body.next_page_params) break;
    query = `?${new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]))}`;
  }
  return out;
}

/** Both contracts' logs from the explorer (each source may fail on its own). */
export async function allCheckoutLogs(pages = 4, f: typeof fetch = fetch): Promise<RawLog[]> {
  const sources = [checkoutAddress(), depositCheckoutAddress()].filter((a): a is Address => !!a);
  const parts = await Promise.allSettled(sources.map((a) => explorerLogs(a, pages, f)));
  if (parts.every((p) => p.status === 'rejected')) throw (parts[0] as PromiseRejectedResult | undefined)?.reason ?? new Error('no checkout contract configured');
  return parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : []));
}

/** An order's events from the contract that holds it, straight from Whitechain's RPC (explorer as the fallback). */
export async function orderEvents(id: Hex, contract: Address, f: typeof fetch = fetch): Promise<CheckoutEvent[]> {
  try {
    const logs = await rpc<RawLog[]>('eth_getLogs', [{ address: contract, fromBlock: toHex(CHECKOUT_DEPLOY_BLOCK), toBlock: 'latest', topics: [null, id] }]);
    return decodeCheckoutLogs(logs).filter((e) => e.id === id.toLowerCase());
  } catch {
    return decodeCheckoutLogs(await explorerLogs(contract, 8, f)).filter((e) => e.id === id.toLowerCase());
  }
}

export type Finality = { block: number; safe: number | null; finalized: number | null };
/** Whitechain's three stages for a block: sequencer-confirmed (it exists), posted to Ethereum (safe ≥ block), final (finalized ≥ block). */
export async function readFinality(block: number): Promise<Finality> {
  const head = (t: 'safe' | 'finalized') => rpc<{ number: Hex } | null>('eth_getBlockByNumber', [t, false]).then((b) => (b ? Number(BigInt(b.number)) : null)).catch(() => null);
  const [safe, finalized] = await Promise.all([head('safe'), head('finalized')]);
  return { block, safe, finalized };
}
export const finalityStage = (f: Finality): 0 | 1 | 2 | 3 =>
  (f.finalized !== null && f.finalized >= f.block ? 3 : f.safe !== null && f.safe >= f.block ? 2 : 1);

export const blockTime = (block: number) =>
  rpc<{ timestamp: Hex } | null>('eth_getBlockByNumber', [toHex(block), false]).then((b) => (b ? Number(BigInt(b.timestamp)) * 1000 : null));

// ---- merchant views

export type OrderRow = {
  id: Hex; method: PayMethod; merchant: Address; payer: Address; amount: bigint; ref: Hex; paidAt: number | null; tx: Hex;
  refunded: bigint; refunds: { amount: bigint; tx: Hex; at: number | null }[]; returned: bigint;
};
export type SubRow = { id: Hex; merchant: Address; payer: Address; amount: bigint; period: number; cycles: number; charged: number; cancelled: boolean; started: number | null; charges: { cycle: number; amount: bigint; tx: Hex; at: number | null }[] };

const isOf = (who: Address[]) => (a: Address) => who.some((w) => w.toLowerCase() === a.toLowerCase());

/** Orders (both ways of paying) and subscriptions for these merchant addresses, newest first. */
export function merchantView(events: CheckoutEvent[], merchants: Address[]): { orders: OrderRow[]; subs: SubRow[] } {
  const mine = isOf(merchants);
  const orders = new Map<string, OrderRow>();
  const subs = new Map<string, SubRow>();
  for (const e of [...events].sort(byChain)) {
    if (e.kind === 'paid' && mine(e.merchant)) orders.set(e.id, { id: e.id, method: e.method, merchant: e.merchant, payer: e.payer, amount: e.amount, ref: e.ref, paidAt: e.at ?? null, tx: e.tx, refunded: 0n, refunds: [], returned: 0n });
    if (e.kind === 'refunded') { const o = orders.get(e.id); if (o) { o.refunds.push({ amount: e.amount, tx: e.tx, at: e.at ?? null }); o.refunded = e.totalRefunded; } }
    if (e.kind === 'returned') { const o = orders.get(e.id); if (o) o.returned += e.amount; }
    if (e.kind === 'subscribed' && mine(e.merchant)) subs.set(e.id, { id: e.id, merchant: e.merchant, payer: e.payer, amount: e.amount, period: e.period, cycles: e.cycles, charged: 0, cancelled: false, started: e.at ?? null, charges: [] });
    if (e.kind === 'charged') { const s = subs.get(e.id); if (s) { s.charged = Math.max(s.charged, e.cycle); s.charges.push({ cycle: e.cycle, amount: e.amount, tx: e.tx, at: e.at ?? null }); } }
    if (e.kind === 'cancelled') { const s = subs.get(e.id); if (s) s.cancelled = true; }
  }
  return { orders: [...orders.values()].reverse(), subs: [...subs.values()].reverse() };
}

/** When the next charge is due (ms), or null when finished/cancelled. Mirrors nextChargeAt on chain. */
export const nextCharge = (s: SubRow): number | null =>
  s.cancelled || s.charged >= s.cycles || s.started === null ? null : s.started + s.charged * s.period * 1000;

export const shortRef = (h: Hex) => `#${h.slice(2, 8)}`;
export const methodLabel = (m: PayMethod) => (m === 'signed' ? 'Signed in wallet' : 'Sent from an exchange or wallet');

/** Totals for Home: what these merchants took through Checkout and what they refunded. */
export function checkoutTotals(orders: OrderRow[]) {
  const paid = orders.reduce((s, o) => s + o.amount, 0n);
  const refunded = orders.reduce((s, o) => s + o.refunded, 0n);
  return { orders: orders.length, paid, refunded, net: paid - refunded };
}
