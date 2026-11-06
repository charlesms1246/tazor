// x402 client for agents: pays HTTP 402 "exact" requirements in USDT on Whitechain with EIP-3009
// transferWithAuthorization (the agent needs USDT only, no WBT). A hard spend cap (maxValue) is enforced per request.
import { getAddress, toHex, type Address, type Hex } from 'viem';
import { CHAIN_ID, TRANSFER_TYPES, USDT, type Signer, type TypedData } from './checkout.ts';

export const NETWORKS = ['whitechain-sepolia', `eip155:${CHAIN_ID}`];

export type PaymentRequirements = {
  scheme: string; network: string; maxAmountRequired: string; resource?: string; description?: string; mimeType?: string;
  payTo: string; maxTimeoutSeconds?: number; asset: string; extra?: { name?: string; version?: string };
};
export type PaymentPayload = {
  x402Version: 1; scheme: 'exact'; network: string;
  payload: { signature: Hex; authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } };
};
export type SettleResponse = { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string };

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export const encodePaymentHeader = (p: PaymentPayload): string => b64(JSON.stringify(p));
export const decodePaymentHeader = (h: string): PaymentPayload => JSON.parse(unb64(h)) as PaymentPayload;
export const decodePaymentResponse = (h: string | null): SettleResponse | null => { if (!h) return null; try { return JSON.parse(unb64(h)) as SettleResponse; } catch { return null; } };

/** The requirement we can pay: exact scheme, Whitechain Sepolia, the official USDT. */
export function pickRequirement(accepts: PaymentRequirements[], usdt: Address = USDT): PaymentRequirements | null {
  return accepts.find((r) => r.scheme === 'exact' && NETWORKS.includes(r.network) && r.asset.toLowerCase() === usdt.toLowerCase()) ?? null;
}

const random32 = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** Signs the transferWithAuthorization that pays one requirement. */
export async function buildPayment(req: PaymentRequirements, signer: Signer, now = Math.floor(Date.now() / 1000), nonce: Hex = random32()): Promise<PaymentPayload> {
  const validBefore = now + Math.min(req.maxTimeoutSeconds ?? 600, 600);
  const authorization = { from: signer.address, to: getAddress(req.payTo), value: BigInt(req.maxAmountRequired), validAfter: BigInt(now - 60), validBefore: BigInt(validBefore), nonce };
  const td: TypedData = {
    domain: { name: req.extra?.name ?? 'Tether USD', version: req.extra?.version ?? '1', chainId: CHAIN_ID, verifyingContract: getAddress(req.asset) },
    types: TRANSFER_TYPES, primaryType: 'TransferWithAuthorization', message: authorization,
  };
  const signature = await signer.signTypedData(td);
  return {
    x402Version: 1, scheme: 'exact', network: req.network,
    payload: { signature, authorization: { ...authorization, value: authorization.value.toString(), validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString() } },
  };
}

export type PayFetchResult = { response: Response; paid: { value: bigint; payTo: Address; settlement: SettleResponse | null } | null };

/**
 * fetch() that pays a 402 once. Refuses (throws) if the price is above maxValue (USDT base units), the agent's spend cap.
 */
export async function payFetch(url: string, opts: { account: Signer; maxValue: bigint; init?: RequestInit; fetch?: typeof fetch; usdt?: Address }): Promise<PayFetchResult> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const first = await f(url, opts.init);
  if (first.status !== 402) return { response: first, paid: null };
  const body = (await first.json().catch(() => null)) as { accepts?: PaymentRequirements[]; error?: string } | null;
  const req = pickRequirement(body?.accepts ?? [], opts.usdt);
  if (!req) throw new Error(`No payable requirement: this server doesn't accept USDT on Whitechain Sepolia${body?.error ? ` (${body.error})` : ''}.`);
  const value = BigInt(req.maxAmountRequired);
  if (value > opts.maxValue) throw new Error(`Refused: the price ${value} exceeds the spend cap ${opts.maxValue} (USDT base units).`);
  const payment = await buildPayment(req, opts.account);
  const headers = new Headers(opts.init?.headers);
  headers.set('X-PAYMENT', encodePaymentHeader(payment));
  const response = await f(url, { ...opts.init, headers });
  return { response, paid: { value, payTo: getAddress(req.payTo), settlement: decodePaymentResponse(response.headers.get('X-PAYMENT-RESPONSE')) } };
}
