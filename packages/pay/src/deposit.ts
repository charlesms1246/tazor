// @tazor/pay deposits: pay by plain USDT transfer (from WhiteBIT, any exchange or any wallet) to a per-order address.
// No signature and no WBT from the customer: anyone settles the order once the address holds the amount; any excess,
// and everything after the deadline, goes back to the customer's refund address.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { CHAIN_ID, DEPOSIT_CHECKOUT, RELAYER_URL, RPC_URL, USDT, USDT_DOMAIN, RECEIVE_TYPES, window1h, type TypedData } from './checkout.ts';

export { DEPOSIT_CHECKOUT };

export const depositAbi = parseAbi([
  'function depositAddress((address merchant,uint256 amount,bytes32 ref,uint64 deadline,address refundTo) o) view returns (address)',
  'function orderId((address merchant,uint256 amount,bytes32 ref,uint64 deadline,address refundTo) o) view returns (bytes32)',
  'function payment(bytes32 id) view returns (address merchant, address refundTo, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)',
  'function refundNonce(bytes32 id, uint256 amount, uint256 refundNo) pure returns (bytes32)',
  'event DepositPaid(bytes32 indexed id, address indexed merchant, address indexed vault, uint256 amount, uint256 excess, bytes32 ref)',
  'event DepositRefunded(bytes32 indexed id, address indexed merchant, address indexed refundTo, uint256 amount, uint256 totalRefunded)',
  'event DepositReturned(bytes32 indexed id, address indexed refundTo, uint256 amount)',
]);

export type DepositOrder = { merchant: Address; amount: bigint; ref: Hex; deadline: bigint; refundTo: Address };
export type DepositOptions = { contract?: Address; rpc?: string; relayer?: string; fetch?: typeof fetch };
export type DepositStatus = {
  status: 'waiting' | 'received' | 'paid' | 'ethereum' | 'finalized' | 'returned' | 'expired';
  balance?: string; txHash?: Hex; explorer?: string; excess?: string;
};

const f0 = (o: DepositOptions) => o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

async function call(o: DepositOptions, data: Hex): Promise<Hex> {
  const res = await f0(o)(o.rpc ?? RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: o.contract ?? DEPOSIT_CHECKOUT, data }, 'latest'] }) });
  const j = (await res.json()) as { result?: Hex; error?: { message: string } };
  if (!j.result) throw new Error(j.error?.message ?? 'eth_call failed');
  return j.result;
}

/** The order plus its deposit address and id, both read from the contract (never computed off chain). */
export async function depositOrder(args: { merchant: string; amount: bigint; ref: Hex; refundTo: string; deadline?: bigint } & DepositOptions) {
  const order: DepositOrder = {
    merchant: getAddress(args.merchant), amount: args.amount, ref: args.ref, refundTo: getAddress(args.refundTo),
    deadline: args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 24 * 3600),
  };
  const [depositAddress, orderId] = await Promise.all([
    call(args, encodeFunctionData({ abi: depositAbi, functionName: 'depositAddress', args: [order] })).then((d) => decodeFunctionResult({ abi: depositAbi, functionName: 'depositAddress', data: d }) as Address),
    call(args, encodeFunctionData({ abi: depositAbi, functionName: 'orderId', args: [order] })).then((d) => decodeFunctionResult({ abi: depositAbi, functionName: 'orderId', data: d }) as Hex),
  ]);
  return { order, depositAddress: getAddress(depositAddress), orderId };
}

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** The order as the relayer's status route takes it: base64url(JSON) with decimal strings. */
export const encodeDepositOrder = (o: DepositOrder) =>
  b64url(JSON.stringify({ merchant: o.merchant, amount: o.amount.toString(), ref: o.ref, deadline: o.deadline.toString(), refundTo: o.refundTo }));

export async function depositStatus(o: DepositOrder, opts: DepositOptions = {}): Promise<DepositStatus> {
  const relayer = (opts.relayer ?? RELAYER_URL).replace(/\/+$/, '');
  const res = await f0(opts)(`${relayer}/checkout/deposit/status?order=${encodeDepositOrder(o)}`);
  const j = (await res.json().catch(() => ({}))) as DepositStatus & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `relayer returned ${res.status}`);
  return j;
}

const DONE = new Set(['finalized', 'returned', 'expired']);
/** Polls the status and reports every change until it is final (or stop()). */
export function watchDeposit(o: DepositOrder, onUpdate: (s: DepositStatus) => void, opts: DepositOptions & { intervalMs?: number } = {}): () => void {
  let stopped = false;
  let last = '';
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await depositStatus(o, opts);
      const key = `${s.status}:${s.balance ?? ''}:${s.txHash ?? ''}`;
      if (key !== last) { last = key; onUpdate(s); }
      if (DONE.has(s.status)) return;
    } catch { /* keep polling */ }
    if (!stopped) setTimeout(tick, opts.intervalMs ?? 4000);
  };
  void tick();
  return () => { stopped = true; };
}

const TAG_REFUND = keccak256(toHex('tazor.deposit.refund'));
export const depositRefundNonce = (id: Hex, amount: bigint, refundNo: bigint | number): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [TAG_REFUND, id, amount, BigInt(refundNo)]));

/** The merchant's 3009 signature for a deposit refund (paid to the order's refund address only). */
export function depositRefundTypedData(id: Hex, merchant: Address, amount: bigint, refundNo: number, opts: { contract?: Address; usdt?: Address; chainId?: number } = {}): TypedData {
  const w = window1h();
  return {
    domain: USDT_DOMAIN(opts.usdt ?? USDT, opts.chainId ?? CHAIN_ID), types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization',
    message: { from: getAddress(merchant), to: opts.contract ?? DEPOSIT_CHECKOUT, value: amount, validAfter: w.validAfter, validBefore: w.validBefore, nonce: depositRefundNonce(id, amount, refundNo) },
  };
}

/** An SVG QR code for the deposit address (just the address, which every exchange's withdrawal screen accepts). */
export async function addressQrSvg(address: string, cell = 4): Promise<string> {
  type Qr = { addData(s: string): void; make(): void; createSvgTag(o: { cellSize: number; margin: number; scalable: boolean }): string };
  // the app's own QR library (bundled into tazor-pay.js); it ships no types at this path
  // @ts-ignore
  const { default: qrcode } = (await import('../../../apps/web/node_modules/qrcode-generator/dist/qrcode.mjs')) as { default: (type: number, level: string) => Qr };
  const qr = qrcode(0, 'M');
  qr.addData(getAddress(address));
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}
