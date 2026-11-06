/**
 * Read-only access to the real WB Soul registry on Whitechain mainnet (chain 1875).
 * Payments on testnet use the labelled mirror in lib/soul.ts; this module never feeds a payment decision.
 * Both endpoints below answer browsers with Access-Control-Allow-Origin: *.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from 'viem';
import { IS_VERIFIED_ATTRIBUTE, VERIFIED, soulAbi } from './soul.ts';

export const MAINNET_RPC = 'https://rpc.whitechain.io';
export const MAINNET_EXPLORER = 'https://explorer.whitechain.io';
export const MAINNET_CHAIN_ID = 1875;
export const WB_SOUL: Address = '0x0000000000000000000000000000000000002000';
export const SOUL_ATTRIBUTES: Address = '0x0000000000000000000000000000000000002002';
/** keccak256("AddressAssigned(address,uint256)") */
export const ADDRESS_ASSIGNED_TOPIC = '0xfad3b1c7127e49654732fe2e0bde7609628f7de1ac7c53a3330dfe6b01c291a5';
export const TIMEOUT_MS = 4000;

type Fetch = typeof fetch;

export type MainnetSoul = { soulId: bigint | null; verified: boolean | null; error?: string };

export const mainnetAddressUrl = (a: string) => `${MAINNET_EXPLORER}/address/${a}`;
export const mainnetTxUrl = (h: string) => `${MAINNET_EXPLORER}/tx/${h}`;

const errText = (e: unknown) => (e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e));

async function call(f: Fetch, signal: AbortSignal, to: Address, data: Hex): Promise<Hex> {
  const res = await f(MAINNET_RPC, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = (await res.json()) as { result?: Hex; error?: { message?: string } };
  if (j.error || typeof j.result !== 'string') throw new Error(j.error?.message ?? 'no result');
  return j.result;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/**
 * The address's soul on mainnet and whether it carries IsVerified = 1.
 * soulId null + verified false: no soul. verified null: unknown (see error). Never throws.
 */
export async function readMainnetSoul(address: string, f: Fetch = globalThis.fetch, ms = TIMEOUT_MS): Promise<MainnetSoul> {
  if (!isAddress(address, { strict: false })) return { soulId: null, verified: null, error: 'not an address' };
  const { signal, done } = withTimeout(ms);
  try {
    const person = getAddress(address);
    const raw = await call(f, signal, WB_SOUL, encodeFunctionData({ abi: soulAbi, functionName: 'soulOf', args: [person] }));
    const soulId = decodeFunctionResult({ abi: soulAbi, functionName: 'soulOf', data: raw }) as bigint;
    if (soulId === 0n) return { soulId: null, verified: false };
    const v = await call(f, signal, SOUL_ATTRIBUTES, encodeFunctionData({ abi: soulAbi, functionName: 'soulAttributeValue', args: [soulId, IS_VERIFIED_ATTRIBUTE] }));
    const value = decodeFunctionResult({ abi: soulAbi, functionName: 'soulAttributeValue', data: v }) as Hex;
    return { soulId, verified: value.toLowerCase() === VERIFIED };
  } catch (e) {
    return { soulId: null, verified: null, error: errText(e) };
  } finally {
    done();
  }
}

export type SoulStats = {
  /** AddressAssigned events in the explorer's latest page of registry logs. */
  assigned: number;
  /** Unix ms of the newest AddressAssigned in that page. */
  latestAt: number | null;
  latestTx: string | null;
  link: string;
  error?: string;
};

type LogItem = { block_timestamp?: string; transaction_hash?: string; topics?: (string | null)[]; decoded?: { method_call?: string } | null };

/** An honest "WB Soul is live on mainnet" line, from the explorer's latest page of registry logs. Never throws. */
export async function mainnetSoulStats(f: Fetch = globalThis.fetch, ms = TIMEOUT_MS): Promise<SoulStats> {
  const link = `${mainnetAddressUrl(WB_SOUL)}?tab=logs`;
  const { signal, done } = withTimeout(ms);
  try {
    const res = await f(`${MAINNET_EXPLORER}/api/v2/addresses/${WB_SOUL}/logs`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    const j = (await res.json()) as { items?: LogItem[] };
    const items = Array.isArray(j.items) ? j.items : [];
    const assigned = items.filter((i) => i.topics?.[0]?.toLowerCase() === ADDRESS_ASSIGNED_TOPIC || i.decoded?.method_call?.startsWith('AddressAssigned(') === true);
    let latestAt: number | null = null;
    let latestTx: string | null = null;
    for (const i of assigned) {
      const t = i.block_timestamp ? Date.parse(i.block_timestamp) : NaN;
      if (Number.isFinite(t) && (latestAt === null || t > latestAt)) { latestAt = t; latestTx = i.transaction_hash ?? null; }
    }
    return { assigned: assigned.length, latestAt, latestTx, link };
  } catch (e) {
    return { assigned: 0, latestAt: null, latestTx: null, link, error: errText(e) };
  } finally {
    done();
  }
}

/** Short "3 h ago" style age for a past time. */
export function ago(thenMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
