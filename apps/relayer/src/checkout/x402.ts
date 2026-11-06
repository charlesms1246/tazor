import { encodeFunctionData, getAddress, isAddress, isAddressEqual, isHex, recoverTypedDataAddress, size, type Abi, type Address, type Hex } from 'viem';
import { SimulationFailed } from '../sender.ts';
import type { Webhooks } from '../webhooks.ts';
import { CHAIN_ID, USDT, USDT_DOMAIN, authorizationTypes, usdtAbi } from './abi.ts';
import type { CheckoutChain } from './service.ts';

export const X402_NETWORKS = ['whitechain-sepolia', `eip155:${CHAIN_ID}`] as const;
export const MAX_AUTH_WINDOW_SEC = 3600n;

export type PaymentRequirements = {
  scheme: 'exact'; network: string; maxAmountRequired: string; resource: string; description: string; mimeType: string;
  payTo: Address; maxTimeoutSeconds: number; asset: Address; extra?: { name?: string; version?: string };
};
export type Authorization = { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
export type PaymentPayload = { x402Version: number; scheme: string; network: string; payload: { signature: Hex; authorization: Authorization } };
export type VerifyResponse = { isValid: boolean; invalidReason?: string; payer?: Address };
export type SettleResponse = { success: boolean; errorReason?: string; transaction: Hex | ''; network: string; payer?: Address };

/** The chain calls the facilitator needs: reads, an eth_call simulation, sending, and a receipt. */
export type X402Chain = Pick<CheckoutChain, 'read' | 'send' | 'wait'> & {
  simulate(to: Address, data: Hex): Promise<{ ok: true } | { ok: false; error: string }>;
};

class Invalid extends Error {}
const fail = (reason: string): never => { throw new Invalid(reason); };
const big = (v: unknown, reason: string) => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : fail(reason));

/**
 * An x402 v1 facilitator for the "exact" scheme on Whitechain Sepolia: verify and settle a USDT
 * transferWithAuthorization (EIP-3009) that an agent signed. It only pays gas for authorizations that are
 * exact, unused, funded, short-lived and simulate cleanly.
 */
export function createX402(o: { chain: X402Chain; usdt?: Address; now?: () => number; webhooks?: Webhooks }) {
  const usdt = o.usdt ?? USDT;
  const nowSec = () => BigInt(Math.floor((o.now ?? Date.now)() / 1000));

  const supported = () => ({ kinds: X402_NETWORKS.map((network) => ({ x402Version: 1, scheme: 'exact', network })) });

  const transferData = (a: Authorization, signature: Hex) => encodeFunctionData({
    abi: usdtAbi, functionName: 'transferWithAuthorization',
    args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, signature],
  });

  async function check(body: unknown): Promise<{ payer: Address; auth: Authorization; signature: Hex; req: PaymentRequirements }> {
    const b = (body ?? {}) as { x402Version?: unknown; paymentPayload?: unknown; paymentRequirements?: unknown };
    const p = b.paymentPayload as PaymentPayload | undefined;
    const req = b.paymentRequirements as PaymentRequirements | undefined;
    if ((b.x402Version ?? p?.x402Version) !== 1) fail('invalid_x402_version');
    if (!p || !req || typeof p !== 'object' || typeof req !== 'object') fail('invalid_payload');
    if (p!.scheme !== 'exact' || req!.scheme !== 'exact') fail('invalid_scheme');
    if (!X402_NETWORKS.includes(p!.network as never) || !X402_NETWORKS.includes(req!.network as never)) fail('invalid_network');
    if (typeof req!.asset !== 'string' || !isAddress(req!.asset) || !isAddressEqual(req!.asset, usdt)) fail('invalid_payment_requirements');
    const a = p!.payload?.authorization;
    const signature = p!.payload?.signature;
    if (!a || typeof signature !== 'string' || !isHex(signature) || size(signature) < 65) fail('invalid_exact_evm_payload_signature');
    if (![a!.from, a!.to, req!.payTo].every((x) => typeof x === 'string' && isAddress(x))) fail('invalid_payload');
    if (typeof a!.nonce !== 'string' || !isHex(a!.nonce) || size(a!.nonce) !== 32) fail('invalid_payload');
    if (!isAddressEqual(a!.to, req!.payTo)) fail('invalid_exact_evm_payload_recipient_mismatch');
    // "exact": the agent pays exactly the price; never more (drain), never less
    if (big(a!.value, 'invalid_exact_evm_payload_authorization_value') !== big(req!.maxAmountRequired, 'invalid_payment_requirements')) fail('invalid_exact_evm_payload_authorization_value');
    const now = nowSec();
    if (big(a!.validAfter, 'invalid_payload') > now) fail('invalid_exact_evm_payload_authorization_valid_after');
    const before = big(a!.validBefore, 'invalid_payload');
    if (before < now + 6n) fail('invalid_exact_evm_payload_authorization_valid_before');
    if (before - now > MAX_AUTH_WINDOW_SEC) fail('invalid_exact_evm_payload_authorization_valid_before');
    const payer = getAddress(a!.from);
    // an EOA signature is recovered here; anything else (ERC-1271 wallets) is proven by the simulation below
    if (size(signature as Hex) === 65) {
      const domain = { ...USDT_DOMAIN, verifyingContract: usdt, name: req!.extra?.name ?? USDT_DOMAIN.name, version: req!.extra?.version ?? USDT_DOMAIN.version };
      const message = { from: payer, to: getAddress(a!.to), value: BigInt(a!.value), validAfter: BigInt(a!.validAfter), validBefore: before, nonce: a!.nonce };
      const signer = await recoverTypedDataAddress({ domain, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message, signature: signature as Hex }).catch(() => null);
      if (!signer || !isAddressEqual(signer, payer)) fail('invalid_exact_evm_payload_signature');
    }
    if (await o.chain.read<boolean>(usdt, usdtAbi as unknown as Abi, 'authorizationState', [payer, a!.nonce])) fail('invalid_transaction_state');
    if ((await o.chain.read<bigint>(usdt, usdtAbi as unknown as Abi, 'balanceOf', [payer])) < BigInt(a!.value)) fail('insufficient_funds');
    const sim = await o.chain.simulate(usdt, transferData(a!, signature as Hex));
    if (!sim.ok) fail(/signature/i.test(sim.error) ? 'invalid_exact_evm_payload_signature' : 'invalid_transaction_state');
    return { payer, auth: a!, signature: signature as Hex, req: req! };
  }

  async function verify(body: unknown): Promise<VerifyResponse> {
    try {
      const { payer } = await check(body);
      return { isValid: true, payer };
    } catch (e) {
      if (e instanceof Invalid) return { isValid: false, invalidReason: e.message, payer: payerOf(body) };
      throw e;
    }
  }

  /** Verifies, then (after `guard`, the gas budget) sends transferWithAuthorization and waits for the receipt. */
  async function settle(body: unknown, guard?: (payer: Address) => Promise<void>): Promise<SettleResponse> {
    const network = ((body as { paymentRequirements?: { network?: string } })?.paymentRequirements?.network) ?? X402_NETWORKS[0];
    let checked;
    try { checked = await check(body); } catch (e) {
      if (e instanceof Invalid) return { success: false, errorReason: e.message, transaction: '', network, payer: payerOf(body) };
      throw e;
    }
    const { payer, auth, signature, req } = checked;
    await guard?.(payer);
    let tx: Hex;
    try { tx = await o.chain.send(usdt, transferData(auth, signature)); } catch (e) {
      if (e instanceof SimulationFailed) return { success: false, errorReason: 'invalid_transaction_state', transaction: '', network, payer };
      throw e;
    }
    const r = await o.chain.wait(tx);
    if (r.status !== 'success') return { success: false, errorReason: 'unexpected_settle_error', transaction: tx, network, payer };
    await o.webhooks?.emit({
      id: `x402:${auth.nonce}`, type: 'x402.settled', merchant: req.payTo, txHash: tx,
      data: { payer, payTo: getAddress(req.payTo), amount: auth.value, resource: req.resource, network, nonce: auth.nonce },
    }).catch(() => null);
    return { success: true, transaction: tx, network, payer };
  }

  /** Settlements to one payTo, from the x402.settled deliveries (memory per instance, or KV). */
  async function settlements(payTo: Address) {
    const list = o.webhooks ? await o.webhooks.recent(payTo) : [];
    return list.filter((d) => d.type === 'x402.settled').map((d) => ({
      id: d.id, created: d.created, txHash: d.txHash, payer: d.data.payer, amount: d.data.amount, resource: d.data.resource, network: d.data.network,
    }));
  }

  return { supported, verify, settle, settlements };
}
export type X402 = ReturnType<typeof createX402>;

function payerOf(body: unknown): Address | undefined {
  const from = (body as { paymentPayload?: PaymentPayload })?.paymentPayload?.payload?.authorization?.from;
  return typeof from === 'string' && isAddress(from) ? getAddress(from) : undefined;
}

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
export const decodeHeader = (h: string): unknown => { try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch { return null; } };
export const encodeHeader = encode;

/** Road distance (km) for the demo freight quote; any other pair is estimated. */
const KM: Record<string, number> = { 'mumbai:pune': 148, 'mumbai:delhi': 1420, 'mumbai:bengaluru': 984, 'pune:bengaluru': 840, 'delhi:jaipur': 281, 'chennai:bengaluru': 346 };

/** The demo paid API: a freight quote for 0.01 USDT, paid per request with x402. */
export function freightQuote(from: string, to: string) {
  const a = from.trim().toLowerCase();
  const b = to.trim().toLowerCase();
  const km = KM[`${a}:${b}`] ?? KM[`${b}:${a}`] ?? 500;
  return {
    from, to, distanceKm: km, truck: km > 600 ? '32 ft multi-axle' : '19 ft', transitDays: Math.max(1, Math.ceil(km / 450)),
    priceINR: Math.round(km * 42 + 1500), currency: 'INR', validMinutes: 30, simulated: true,
  };
}

export const demoRequirements = (resource: string, payTo: Address, usdt: Address = USDT): PaymentRequirements => ({
  scheme: 'exact', network: X402_NETWORKS[0], maxAmountRequired: '10000', resource,
  description: 'Freight quote (demo data), 0.01 USDT per request', mimeType: 'application/json',
  payTo, maxTimeoutSeconds: 300, asset: usdt, extra: { name: 'Tether USD', version: '1' },
});
