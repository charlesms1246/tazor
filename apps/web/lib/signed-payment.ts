/**
 * A "signed payment": everything needed to deliver an approved invoice through Ethereum (EnsGate.forward on Sepolia)
 * without Tazor's site, relayer or servers. Pay copies it; public/fallback.html and scripts/forward.ts send it.
 * Format: "tazor-signed-payment:1:" + base64url(JSON). Nothing in it is secret: it is an approval for one invoice.
 */
import { encodeFunctionData, getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { ensGateAbi } from './abi/EnsGate.ts';

export const SIGNED_PAYMENT_PREFIX = 'tazor-signed-payment:1:';

export type SignedPayment = {
  v: 1;
  /** EnsGate on Ethereum Sepolia (v1 or v2, by the paying account). */
  gate: Address;
  sepoliaChainId: 11155111;
  whitechainChainId: number;
  /** The PaymentModule on Whitechain that emits InvoicePaid (to watch for delivery). */
  paymentModule: Address;
  label: string;
  account: Address;
  auth: { invoiceHash: Hex; account: Address; payee: Address; amount: string; expiry: string; nonce: string };
  approvers: Address[];
  signatures: Hex[];
  invoiceId?: string;
  supplier?: string;
};

const b64urlEncode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

export function encodeSignedPayment(p: SignedPayment): string {
  return SIGNED_PAYMENT_PREFIX + b64urlEncode(JSON.stringify(p));
}

const UINT = /^\d+$/;

/** Parses and checks a pasted signed payment; throws a plain-English error when it isn't one. */
export function decodeSignedPayment(text: string): SignedPayment {
  const t = text.trim();
  if (!t.startsWith(SIGNED_PAYMENT_PREFIX)) throw new Error('This is not a Tazor signed payment (it should start with "tazor-signed-payment:1:").');
  let p: SignedPayment;
  try { p = JSON.parse(b64urlDecode(t.slice(SIGNED_PAYMENT_PREFIX.length))) as SignedPayment; } catch { throw new Error('The signed payment is damaged; copy it again from the Pay page.'); }
  const addr = (v: unknown) => typeof v === 'string' && isAddress(v);
  const ok = p && p.v === 1 && p.sepoliaChainId === 11155111 && addr(p.gate) && addr(p.paymentModule) && addr(p.account)
    && typeof p.label === 'string' && /^[a-z0-9-]{1,63}$/.test(p.label)
    && p.auth && isHex(p.auth.invoiceHash) && addr(p.auth.account) && addr(p.auth.payee)
    && UINT.test(p.auth.amount) && UINT.test(p.auth.expiry) && UINT.test(p.auth.nonce)
    && Array.isArray(p.approvers) && Array.isArray(p.signatures) && p.approvers.length > 0 && p.approvers.length === p.signatures.length
    && p.approvers.every(addr) && p.signatures.every((s) => isHex(s));
  if (!ok) throw new Error('The signed payment is incomplete; copy it again from the Pay page.');
  if (getAddress(p.auth.account) !== getAddress(p.account)) throw new Error('The signed payment is inconsistent (two different accounts).');
  return p;
}

/** The EnsGate.forward calldata for a signed payment. */
export function forwardCalldata(p: SignedPayment): Hex {
  return encodeFunctionData({
    abi: ensGateAbi, functionName: 'forward',
    args: [p.label, getAddress(p.account), {
      invoiceHash: p.auth.invoiceHash, account: getAddress(p.auth.account), payee: getAddress(p.auth.payee),
      amount: BigInt(p.auth.amount), expiry: BigInt(p.auth.expiry), nonce: BigInt(p.auth.nonce),
    }, p.approvers.map((a) => getAddress(a)), p.signatures],
  });
}

/** Builds the signed payment for an approved invoice (signatures must be the inner, unwrapped ones the contracts read). */
export function signedPaymentFrom(x: {
  gate: Address; paymentModule: Address; whitechainChainId: number; label: string;
  auth: { invoiceHash: Hex; account: Address; payee: Address; amount: bigint; expiry: bigint; nonce: bigint };
  approvals: { approver: Address; signature: Hex }[]; invoiceId?: string; supplier?: string;
}): string {
  return encodeSignedPayment({
    v: 1, gate: x.gate, sepoliaChainId: 11155111, whitechainChainId: x.whitechainChainId, paymentModule: x.paymentModule, label: x.label,
    account: x.auth.account,
    auth: { invoiceHash: x.auth.invoiceHash, account: x.auth.account, payee: x.auth.payee, amount: x.auth.amount.toString(), expiry: x.auth.expiry.toString(), nonce: x.auth.nonce.toString() },
    approvers: x.approvals.map((a) => a.approver), signatures: x.approvals.map((a) => a.signature),
    ...(x.invoiceId ? { invoiceId: x.invoiceId } : {}), ...(x.supplier ? { supplier: x.supplier } : {}),
  });
}
