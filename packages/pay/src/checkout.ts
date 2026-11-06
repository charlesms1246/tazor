// @tazor/pay checkout: gasless wallet checkout, refunds and subscriptions on Whitechain with the official USDT.
// The payer signs ONE EIP-3009 authorization (no gas, no WBT); Tazor's relayer submits it to TazorCheckout.
// Ids and nonces are computed exactly as the contract computes them. Depends only on viem (usable from the app too).
import {
  decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, pad, keccak256, parseAbi, toHex, type Address, type Hex, type TypedDataDomain,
} from 'viem';

export const CHAIN_ID = 1874;
export const USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
export const RPC_URL = 'https://rpc.testnet.whitechain.io';
export const EXPLORER = 'https://explorer.testnet.whitechain.io';
export const RELAYER_URL = 'https://tazor-relayer.vercel.app';
/** TazorCheckout on Whitechain Sepolia (Blockscout-verified). */
export const CHECKOUT: Address = '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670';

export type Order = { merchant: Address; amount: bigint; ref: Hex; deadline: bigint };
export type Plan = { merchant: Address; amount: bigint; period: number; cycles: number; ref: Hex };
export type Authorization = { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };

export const USDT_DOMAIN = (usdt: Address = USDT, chainId = CHAIN_ID): TypedDataDomain => ({ name: 'Tether USD', version: '1', chainId, verifyingContract: usdt });
export const CHECKOUT_DOMAIN = (checkout: Address, chainId = CHAIN_ID): TypedDataDomain => ({ name: 'TazorCheckout', version: '1', chainId, verifyingContract: checkout });

const AUTH_FIELDS = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] as const;
export const RECEIVE_TYPES = { ReceiveWithAuthorization: AUTH_FIELDS } as const;
export const TRANSFER_TYPES = { TransferWithAuthorization: AUTH_FIELDS } as const;
export const PERMIT_TYPES = {
  Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
} as const;
export const CANCEL_TYPES = { Cancel: [{ name: 'subId', type: 'bytes32' }] } as const;

export const checkoutAbi = parseAbi([
  'event OrderPaid(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, bytes32 ref)',
  'event Refunded(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint256 totalRefunded)',
  'event Subscribed(bytes32 indexed id, address indexed merchant, address indexed payer, uint256 amount, uint32 period, uint16 cycles, bytes32 ref)',
  'event Charged(bytes32 indexed id, uint16 cycle, uint256 amount)',
  'event Cancelled(bytes32 indexed id, address by)',
  'function payment(bytes32 id) view returns (address merchant, address payer, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)',
  'function subscription(bytes32 id) view returns (address merchant, address payer, uint256 amount, uint32 period, uint16 cycles, uint16 charged, uint64 start, bool active)',
  'function nextChargeAt(bytes32 id) view returns (uint64)',
  'function cancelDigest(bytes32 id) view returns (bytes32)',
  'error Expired()', 'error AlreadyPaid()', 'error NotPaid()', 'error RefundTooLarge()', 'error NotDue()', 'error NotActive()', 'error NotParty()', 'error BadPlan()',
]);

// ---- ids and nonces (abi.encode + keccak256, as the contract does)

const TAG_PAY = keccak256(toHex('tazor.checkout.pay'));
const TAG_REFUND = keccak256(toHex('tazor.checkout.refund'));
const TAG_SUBSCRIBE = keccak256(toHex('tazor.checkout.subscribe'));

/** A 32-byte order reference from your own order number (keccak256 of its UTF-8 bytes). */
export const orderRef = (orderNumber: string): Hex => keccak256(toHex(orderNumber));

export const orderId = (o: Order, checkout: Address, chainId = CHAIN_ID): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [BigInt(chainId), checkout, o.merchant, o.ref]));

export const payNonce = (o: Order, checkout: Address, chainId = CHAIN_ID): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }], [TAG_PAY, orderId(o, checkout, chainId), o.amount, o.deadline]));

export const refundNonce = (id: Hex, amount: bigint, refundNo: bigint | number): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [TAG_REFUND, id, amount, BigInt(refundNo)]));

const PLAN_TUPLE = { type: 'tuple', components: [
  { name: 'merchant', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'period', type: 'uint32' }, { name: 'cycles', type: 'uint16' }, { name: 'ref', type: 'bytes32' },
] } as const;

export const subId = (p: Plan, payer: Address, checkout: Address, chainId = CHAIN_ID): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, PLAN_TUPLE, { type: 'address' }], [BigInt(chainId), checkout, p, payer]));

export const subNonce = (p: Plan, payer: Address, checkout: Address, chainId = CHAIN_ID): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [TAG_SUBSCRIBE, subId(p, payer, checkout, chainId)]));

// ---- typed data (ready for eth_signTypedData_v4 or a viem account)

export type TypedData = { domain: TypedDataDomain; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };

const nowS = () => BigInt(Math.floor(Date.now() / 1000));
/** Signatures stay valid for at most an hour (and never past the order's deadline). */
export const window1h = (deadline?: bigint, now = nowS()) => {
  const end = now + 3600n;
  return { validAfter: 0n, validBefore: deadline !== undefined && deadline < end ? deadline : end };
};

const receive = (a: Authorization, usdt: Address, chainId: number): TypedData =>
  ({ domain: USDT_DOMAIN(usdt, chainId), types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message: { ...a } });

/** The payer's one signature for an order: USDT moves payer → checkout, bound to merchant + order + amount. */
export function payTypedData(o: Order, payer: Address, opts: { checkout: Address; usdt?: Address; chainId?: number; validAfter?: bigint; validBefore?: bigint }): TypedData {
  const w = window1h(o.deadline);
  return receive({ from: getAddress(payer), to: opts.checkout, value: o.amount, validAfter: opts.validAfter ?? w.validAfter, validBefore: opts.validBefore ?? w.validBefore, nonce: payNonce(o, opts.checkout, opts.chainId) }, opts.usdt ?? USDT, opts.chainId ?? CHAIN_ID);
}

/** The merchant's signature for a refund; the contract sends it only to the original payer. refundNo = refunds made so far. */
export function refundTypedData(id: Hex, merchant: Address, amount: bigint, refundNo: bigint | number, opts: { checkout: Address; usdt?: Address; chainId?: number; validAfter?: bigint; validBefore?: bigint }): TypedData {
  const w = window1h();
  return receive({ from: getAddress(merchant), to: opts.checkout, value: amount, validAfter: opts.validAfter ?? w.validAfter, validBefore: opts.validBefore ?? w.validBefore, nonce: refundNonce(id, amount, refundNo) }, opts.usdt ?? USDT, opts.chainId ?? CHAIN_ID);
}

/** A subscription needs two signatures: the first cycle (3009, nonce commits to the plan) and a permit for the later pulls. */
export function subscribeTypedData(p: Plan, payer: Address, opts: { checkout: Address; permitNonce: bigint; permitValue?: bigint; permitDeadline?: bigint; usdt?: Address; chainId?: number }) {
  const chainId = opts.chainId ?? CHAIN_ID;
  const usdt = opts.usdt ?? USDT;
  const w = window1h();
  const permitValue = opts.permitValue ?? p.amount * BigInt(Math.max(0, p.cycles - 1));
  const permitDeadline = opts.permitDeadline ?? nowS() + BigInt(p.period) * BigInt(p.cycles) + 86_400n;
  return {
    first: receive({ from: getAddress(payer), to: opts.checkout, value: p.amount, ...w, nonce: subNonce(p, payer, opts.checkout, chainId) }, usdt, chainId),
    permit: { domain: USDT_DOMAIN(usdt, chainId), types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: getAddress(payer), spender: opts.checkout, value: permitValue, nonce: opts.permitNonce, deadline: permitDeadline } } as TypedData,
    permitValue, permitDeadline, validAfter: w.validAfter, validBefore: w.validBefore,
  };
}

export const cancelTypedData = (id: Hex, checkout: Address, chainId = CHAIN_ID): TypedData =>
  ({ domain: CHECKOUT_DOMAIN(checkout, chainId), types: CANCEL_TYPES, primaryType: 'Cancel', message: { subId: id } });

// ---- signers

export type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
/** Anything that signs typed data: a viem account, or a wrapped EIP-1193 wallet (see walletSigner). */
export type Signer = { address: Address; signTypedData(td: TypedData): Promise<Hex> };

const jsonSafe = (v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(jsonSafe) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)])) : v);

/** eth_signTypedData_v4 JSON (EIP712Domain included, bigints as decimal strings). */
export function toEip712Json(td: TypedData): string {
  const d = td.domain;
  const domainType = [
    ...(d.name !== undefined ? [{ name: 'name', type: 'string' }] : []), ...(d.version !== undefined ? [{ name: 'version', type: 'string' }] : []),
    ...(d.chainId !== undefined ? [{ name: 'chainId', type: 'uint256' }] : []), ...(d.verifyingContract !== undefined ? [{ name: 'verifyingContract', type: 'address' }] : []),
  ];
  return JSON.stringify(jsonSafe({ types: { EIP712Domain: domainType, ...td.types }, domain: d, primaryType: td.primaryType, message: td.message }));
}

const WHITECHAIN_SEPOLIA = {
  chainId: toHex(CHAIN_ID), chainName: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER],
};

/**
 * Wraps a browser wallet. Signing typed data sends no transaction and costs no gas. Some wallets (MetaMask) only sign
 * when the domain's chain is the selected one; then we ask to switch (adding Whitechain Sepolia if the wallet lacks it).
 */
export async function walletSigner(eth: Eip1193): Promise<Signer> {
  const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!address) throw new Error('The wallet shared no account.');
  const sign = (td: TypedData) => eth.request({ method: 'eth_signTypedData_v4', params: [address, toEip712Json(td)] }) as Promise<Hex>;
  return {
    address: getAddress(address),
    async signTypedData(td) {
      try {
        return await sign(td);
      } catch (e) {
        if (!/chain ?id|chainid|active chain/i.test(String((e as Error)?.message ?? e))) throw e;
        try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(Number(td.domain.chainId ?? CHAIN_ID)) }] }); }
        catch (s) {
          if ((s as { code?: number }).code !== 4902) throw s;
          await eth.request({ method: 'wallet_addEthereumChain', params: [WHITECHAIN_SEPOLIA] });
        }
        return sign(td);
      }
    },
  };
}

/** A viem LocalAccount (or any account with signTypedData) as a Signer. */
export const accountSigner = (account: { address: Address; signTypedData: (td: never) => Promise<Hex> }): Signer =>
  ({ address: getAddress(account.address), signTypedData: (td) => account.signTypedData(td as never) });

// ---- relayer calls

export type CheckoutOptions = { checkout?: Address; relayer?: string; fetch?: typeof fetch; usdt?: Address; chainId?: number; rpc?: string };
export type Stage = 'pending' | 'sequencer' | 'ethereum' | 'finalized';
export type OrderStatus = {
  id: Hex; status: 'unpaid' | 'paid' | 'refunded' | 'partially-refunded'; stage: Stage | null;
  merchant?: Address; payer?: Address; amount?: string; refunded?: string; refunds?: number; txHash?: Hex; explorer?: string;
};
export type Submitted = { id: Hex; txHash: Hex; explorer: string; stage?: Stage };

const resolve = (o: CheckoutOptions) => {
  const checkout = o.checkout ?? CHECKOUT;
  if (/^0x0{40}$/i.test(checkout)) throw new Error('TazorCheckout is not deployed yet: pass `checkout` (or set the checkout attribute).');
  return { checkout: getAddress(checkout), relayer: (o.relayer ?? RELAYER_URL).replace(/\/+$/, ''), f: o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)), usdt: o.usdt ?? USDT, chainId: o.chainId ?? CHAIN_ID, rpc: o.rpc ?? RPC_URL };
};

async function post<T>(r: ReturnType<typeof resolve>, path: string, body: unknown): Promise<T> {
  const res = await r.f(`${r.relayer}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(jsonSafe(body)) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) throw new Error(j.reason ?? j.error ?? `relayer returned ${res.status}`);
  return j;
}

const orderJson = (o: Order) => ({ merchant: o.merchant, amount: o.amount.toString(), ref: o.ref, deadline: o.deadline.toString() });
const planJson = (p: Plan) => ({ merchant: p.merchant, amount: p.amount.toString(), period: p.period, cycles: p.cycles, ref: p.ref });

/** Signs the order with the payer's wallet and has the relayer submit it. POST /checkout/pay. */
export async function payOrder(args: { order: Order; wallet: Signer } & CheckoutOptions): Promise<Submitted> {
  const r = resolve(args);
  const td = payTypedData(args.order, args.wallet.address, { checkout: r.checkout, usdt: r.usdt, chainId: r.chainId });
  const signature = await args.wallet.signTypedData(td);
  const m = td.message as unknown as Authorization;
  return post<Submitted>(r, '/checkout/pay', { order: orderJson(args.order), payer: args.wallet.address, validAfter: m.validAfter, validBefore: m.validBefore, signature });
}

/** The merchant refunds (all or part) to the original payer. POST /checkout/refund. refundNo defaults to the on-chain count. */
export async function refundOrder(args: { id: Hex; amount: bigint; wallet: Signer; refundNo?: number } & CheckoutOptions): Promise<Submitted> {
  const r = resolve(args);
  const refundNo = args.refundNo ?? (await readPayment(args.id, args)).refunds;
  const td = refundTypedData(args.id, args.wallet.address, args.amount, refundNo, { checkout: r.checkout, usdt: r.usdt, chainId: r.chainId });
  const signature = await args.wallet.signTypedData(td);
  const m = td.message as unknown as Authorization;
  return post<Submitted>(r, '/checkout/refund', { id: args.id, amount: args.amount, refundNo, validAfter: m.validAfter, validBefore: m.validBefore, signature });
}

/** Subscribes: pays cycle 1 now and permits the later pulls. POST /checkout/subscribe. */
export async function subscribe(args: { plan: Plan; wallet: Signer; permitNonce?: bigint } & CheckoutOptions): Promise<Submitted> {
  const r = resolve(args);
  const permitNonce = args.permitNonce ?? (await usdtNonce(args.wallet.address, args));
  const s = subscribeTypedData(args.plan, args.wallet.address, { checkout: r.checkout, permitNonce, usdt: r.usdt, chainId: r.chainId });
  const firstSig = await args.wallet.signTypedData(s.first);
  const permitSig = await args.wallet.signTypedData(s.permit);
  // subscribe(Plan, payer, Auth first, Auth allowance) with Auth = (validAfter, validBefore, sig); the allowance carries
  // (permitValue, permitDeadline, permitSig). The flat fields are sent too, for relayers that read them.
  return post<Submitted>(r, '/checkout/subscribe', {
    plan: planJson(args.plan), payer: args.wallet.address,
    first: { validAfter: s.validAfter, validBefore: s.validBefore, sig: firstSig },
    allowance: { validAfter: s.permitValue, validBefore: s.permitDeadline, sig: permitSig },
    validAfter: s.validAfter, validBefore: s.validBefore, firstSig, permitValue: s.permitValue, permitDeadline: s.permitDeadline, permitSig,
  });
}

/** Cancels by signature (payer or merchant). POST /checkout/cancel. */
export async function cancelSubscription(args: { id: Hex; wallet: Signer } & CheckoutOptions): Promise<Submitted> {
  const r = resolve(args);
  const signature = await args.wallet.signTypedData(cancelTypedData(args.id, r.checkout, r.chainId));
  // cancelBySig(subId, by, sig): `by` is the signer (payer or merchant)
  return post<Submitted>(r, '/checkout/cancel', { subId: args.id, id: args.id, by: args.wallet.address, signer: args.wallet.address, signature });
}

/** Charges a due cycle (anyone may). POST /checkout/charge. */
export const chargeSubscription = (args: { id: Hex } & CheckoutOptions) => post<Submitted>(resolve(args), '/checkout/charge', { subId: args.id, id: args.id });

/** GET /checkout/order/:id: paid/refunded and the finality stage. */
export async function getOrder(id: Hex, opts: CheckoutOptions = {}): Promise<OrderStatus> {
  const relayer = (opts.relayer ?? RELAYER_URL).replace(/\/+$/, '');
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const res = await f(`${relayer}/checkout/order/${id}`);
  const j = (await res.json().catch(() => ({}))) as OrderStatus & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `relayer returned ${res.status}`);
  return j;
}

const STAGES: Stage[] = ['pending', 'sequencer', 'ethereum', 'finalized'];
/** Polls the order and calls onStage once per new finality stage until finalized (or stop()). */
export function watchOrder(id: Hex, onStage: (stage: Stage, s: OrderStatus) => void, opts: CheckoutOptions & { intervalMs?: number } = {}): () => void {
  let stopped = false;
  let last = -1;
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await getOrder(id, opts);
      const i = s.stage ? STAGES.indexOf(s.stage) : -1;
      if (i > last) { for (let k = Math.max(last + 1, 0); k <= i; k++) onStage(STAGES[k], s); last = i; }
      if (s.stage === 'finalized') return;
    } catch { /* keep polling */ }
    if (!stopped) setTimeout(tick, opts.intervalMs ?? 4000);
  };
  void tick();
  return () => { stopped = true; };
}

// ---- reads straight from Whitechain (no relayer needed)

async function ethCall(rpc: string, f: typeof fetch, to: Address, data: Hex): Promise<Hex> {
  const res = await f(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  const j = (await res.json()) as { result?: Hex; error?: { message: string } };
  if (!j.result) throw new Error(j.error?.message ?? 'eth_call failed');
  return j.result;
}

export async function readPayment(id: Hex, opts: CheckoutOptions = {}) {
  const r = resolve(opts);
  const out = decodeFunctionResult({ abi: checkoutAbi, functionName: 'payment', data: await ethCall(r.rpc, r.f, r.checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'payment', args: [id] })) });
  const [merchant, payer, amount, refunded, paidAt, refunds] = out as readonly [Address, Address, bigint, bigint, bigint, number];
  return { merchant, payer, amount, refunded, paidAt, refunds: Number(refunds) };
}

export async function usdtNonce(owner: Address, opts: CheckoutOptions = {}): Promise<bigint> {
  const abi = parseAbi(['function nonces(address) view returns (uint256)']);
  const rpc = opts.rpc ?? RPC_URL;
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  return decodeFunctionResult({ abi, functionName: 'nonces', data: await ethCall(rpc, f, opts.usdt ?? USDT, encodeFunctionData({ abi, functionName: 'nonces', args: [owner] })) }) as bigint;
}

export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;

// ---- a merchant's history, straight from Whitechain logs (no relayer, no database)

export const CHECKOUT_DEPLOY_BLOCK = 12_391_700n;
export type HistoryRow =
  | { kind: 'paid'; id: Hex; payer: Address; amount: bigint; ref: Hex; tx: Hex; block: bigint }
  | { kind: 'refunded'; id: Hex; payer: Address; amount: bigint; totalRefunded: bigint; tx: Hex; block: bigint }
  | { kind: 'subscribed'; id: Hex; payer: Address; amount: bigint; period: number; cycles: number; ref: Hex; tx: Hex; block: bigint }
  | { kind: 'charged'; id: Hex; cycle: number; amount: bigint; tx: Hex; block: bigint }
  | { kind: 'cancelled'; id: Hex; by: Address; tx: Hex; block: bigint };

type RpcLog = { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex };

/** Every order, refund, subscription, charge and cancellation of one merchant, oldest first. */
export async function merchantHistory(merchant: Address, opts: CheckoutOptions & { fromBlock?: bigint; chunk?: bigint } = {}): Promise<HistoryRow[]> {
  const r = resolve(opts);
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await r.f(r.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  };
  const head = BigInt(await rpc<Hex>('eth_blockNumber', []));
  const from = opts.fromBlock ?? CHECKOUT_DEPLOY_BLOCK;
  const chunk = opts.chunk ?? 50_000n;
  const byMerchant = (eventName: 'OrderPaid' | 'Refunded' | 'Subscribed') => {
    const [t0] = encodeEventTopics({ abi: checkoutAbi, eventName });
    return [t0, null, pad(getAddress(merchant)).toLowerCase() as Hex] as (Hex | null)[];
  };
  const logs: RpcLog[] = [];
  const get = async (topics: (Hex | null | Hex[])[]) => {
    for (let a = from; a <= head; a += chunk) {
      const b = a + chunk - 1n < head ? a + chunk - 1n : head;
      logs.push(...(await rpc<RpcLog[]>('eth_getLogs', [{ address: r.checkout, topics, fromBlock: toHex(a), toBlock: toHex(b) }])));
    }
  };
  await get(byMerchant('OrderPaid'));
  await get(byMerchant('Refunded'));
  await get(byMerchant('Subscribed'));
  const rows: HistoryRow[] = [];
  const subIds = new Set<string>();
  const decode = (l: RpcLog) => decodeEventLog({ abi: checkoutAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
  for (const l of logs) {
    const e = decode(l);
    const base = { tx: l.transactionHash, block: BigInt(l.blockNumber) };
    if (e.eventName === 'OrderPaid') rows.push({ kind: 'paid', id: e.args.id, payer: e.args.payer, amount: e.args.amount, ref: e.args.ref, ...base });
    if (e.eventName === 'Refunded') rows.push({ kind: 'refunded', id: e.args.id, payer: e.args.payer, amount: e.args.amount, totalRefunded: e.args.totalRefunded, ...base });
    if (e.eventName === 'Subscribed') { subIds.add(e.args.id.toLowerCase()); rows.push({ kind: 'subscribed', id: e.args.id, payer: e.args.payer, amount: e.args.amount, period: Number(e.args.period), cycles: Number(e.args.cycles), ref: e.args.ref, ...base }); }
  }
  if (subIds.size) {
    const [charged] = encodeEventTopics({ abi: checkoutAbi, eventName: 'Charged' });
    const [cancelled] = encodeEventTopics({ abi: checkoutAbi, eventName: 'Cancelled' });
    const more: RpcLog[] = [];
    const start = logs.length;
    await get([[charged, cancelled], [...subIds] as Hex[]]);
    more.push(...logs.splice(start));
    for (const l of more) {
      const e = decode(l);
      const base = { tx: l.transactionHash, block: BigInt(l.blockNumber) };
      if (e.eventName === 'Charged' && Number(e.args.cycle) > 1) rows.push({ kind: 'charged', id: e.args.id, cycle: Number(e.args.cycle), amount: e.args.amount, ...base });
      if (e.eventName === 'Cancelled') rows.push({ kind: 'cancelled', id: e.args.id, by: e.args.by, ...base });
    }
  }
  return rows.sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : 0));
}

export async function readSubscription(id: Hex, opts: CheckoutOptions = {}) {
  const r = resolve(opts);
  const out = decodeFunctionResult({ abi: checkoutAbi, functionName: 'subscription', data: await ethCall(r.rpc, r.f, r.checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'subscription', args: [id] })) }) as readonly [Address, Address, bigint, number, number, number, bigint, boolean];
  const next = decodeFunctionResult({ abi: checkoutAbi, functionName: 'nextChargeAt', data: await ethCall(r.rpc, r.f, r.checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'nextChargeAt', args: [id] })) }) as bigint;
  const [merchant, payer, amount, period, cycles, charged, start, active] = out;
  return { merchant, payer, amount, period: Number(period), cycles: Number(cycles), charged: Number(charged), start, active, nextChargeAt: next };
}

/** CSV for the accountant: date-less but exact (block, tx), one row per on-chain event. */
export function historyCsv(rows: HistoryRow[]): string {
  const usd = (v: bigint) => { const s = v.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`; };
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['type', 'id', 'counterparty', 'amount_usdt', 'detail', 'block', 'transaction'].join(',')];
  for (const r of rows) {
    const [who, amount, detail] =
      r.kind === 'paid' ? [r.payer, usd(r.amount), 'order paid'] :
      r.kind === 'refunded' ? [r.payer, `-${usd(r.amount)}`, `refund (total refunded ${usd(r.totalRefunded)})`] :
      r.kind === 'subscribed' ? [r.payer, usd(r.amount), `subscribed: ${r.cycles} × every ${r.period} s (cycle 1 paid)`] :
      r.kind === 'charged' ? ['', usd(r.amount), `subscription cycle ${r.cycle}`] :
      [r.by, '', 'subscription cancelled'];
    lines.push([r.kind, r.id, who, amount, detail, r.block.toString(), r.tx].map((x) => q(String(x))).join(','));
  }
  return lines.join('\n') + '\n';
}
