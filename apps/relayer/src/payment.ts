import { encodeFunctionData, getAddress, isHex, parseAbi, type Address, type Hex } from 'viem';

export const paymentModuleAbi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function payOne(address account, InvoiceAuth auth, address[] approvers, bytes[] signatures)',
]);

export type InvoiceAuth = { invoiceHash: Hex; account: Address; payee: Address; amount: bigint; expiry: bigint; nonce: bigint };
export type PayRequest = { account: Address; auth: InvoiceAuth; approvers: Address[]; signatures: Hex[] };

export class BadRequest extends Error {}

const UINT64_MAX = (1n << 64n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

export const addr = (v: unknown, f: string): Address => {
  try { return getAddress(v as string); } catch { throw new BadRequest(`${f} must be an address`); }
};
export const hex = (v: unknown, f: string, bytes?: number): Hex => {
  if (typeof v !== 'string' || !isHex(v, { strict: true }) || v.length % 2 !== 0) throw new BadRequest(`${f} must be hex`);
  if (bytes !== undefined && v.length !== 2 + bytes * 2) throw new BadRequest(`${f} must be ${bytes} bytes`);
  return v;
};
export const uint = (v: unknown, f: string, max: bigint): bigint => {
  if (!((typeof v === 'string' && /^(0|[1-9]\d*|0x[0-9a-fA-F]+)$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))) {
    throw new BadRequest(`${f} must be a non-negative integer (decimal string)`);
  }
  const n = BigInt(v);
  if (n > max) throw new BadRequest(`${f} out of range`);
  return n;
};

export function parsePayRequest(body: unknown): PayRequest {
  if (typeof body !== 'object' || body === null) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const a = b.auth as Record<string, unknown> | undefined;
  if (typeof a !== 'object' || a === null) throw new BadRequest('auth must be an object');
  if (!Array.isArray(b.approvers) || !Array.isArray(b.signatures)) throw new BadRequest('approvers and signatures must be arrays');
  if (b.approvers.length === 0 || b.approvers.length !== b.signatures.length) {
    throw new BadRequest('approvers and signatures must be non-empty and the same length');
  }
  return {
    account: addr(b.account, 'account'),
    auth: {
      invoiceHash: hex(a.invoiceHash, 'auth.invoiceHash', 32),
      account: addr(a.account, 'auth.account'),
      payee: addr(a.payee, 'auth.payee'),
      amount: uint(a.amount, 'auth.amount', UINT256_MAX),
      expiry: uint(a.expiry, 'auth.expiry', UINT64_MAX),
      nonce: uint(a.nonce, 'auth.nonce', UINT256_MAX),
    },
    approvers: b.approvers.map((v, i) => addr(v, `approvers[${i}]`)),
    signatures: b.signatures.map((v, i) => hex(v, `signatures[${i}]`)),
  };
}

export const encodePayOne = (r: PayRequest): Hex =>
  encodeFunctionData({ abi: paymentModuleAbi, functionName: 'payOne', args: [r.account, r.auth, r.approvers, r.signatures] });
