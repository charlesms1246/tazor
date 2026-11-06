import type { Hex } from 'viem';
import { config } from './config.ts';
import { configV2 } from './config-v2.ts';
import { getRelayerUrl } from './relayer-url.ts';

export type Health = {
  checkedAt: number;
  relayer: { configured: boolean; ok: boolean; url: string; ms?: number; roleSync?: boolean; watchRegistries?: string[]; mirrorEnabled?: boolean; mirrorReason?: string };
  whitechain: { ok: boolean; block?: number; ageSec?: number };
  ethereum: { ok: boolean; block?: number };
  fallback: { ready: boolean; reason: string };
};

const TIMEOUT_MS = 4000;

async function jsonRpc<T>(f: typeof fetch, url: string, method: string, params: unknown[]): Promise<T> {
  const res = await f(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.result as T;
}

async function relayer(f: typeof fetch): Promise<Health['relayer']> {
  let url = '';
  try { url = getRelayerUrl(); } catch { /* storage unavailable */ }
  if (!url) return { configured: false, ok: false, url: '' };
  const start = Date.now();
  try {
    const res = await f(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json();
    return {
      configured: true, ok: res.ok && body?.ok === true, url, ms: Date.now() - start,
      ...(typeof body?.roleSync === 'boolean' ? { roleSync: body.roleSync } : {}),
      ...(Array.isArray(body?.watchRegistries) ? { watchRegistries: body.watchRegistries.map(String) } : {}),
      ...(typeof body?.mirrorEnabled === 'boolean' ? { mirrorEnabled: body.mirrorEnabled } : {}),
      ...(typeof body?.mirrorReason === 'string' ? { mirrorReason: body.mirrorReason } : {}),
    };
  } catch {
    return { configured: true, ok: false, url };
  }
}

async function whitechain(f: typeof fetch, now: number): Promise<Health['whitechain']> {
  try {
    const b = await jsonRpc<{ number: Hex; timestamp: Hex }>(f, config.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
    return { ok: true, block: Number(BigInt(b.number)), ageSec: Math.max(0, Math.round(now / 1000 - Number(BigInt(b.timestamp)))) };
  } catch {
    return { ok: false };
  }
}

async function ethereum(f: typeof fetch): Promise<Health['ethereum']> {
  try {
    return { ok: true, block: Number(BigInt(await jsonRpc<Hex>(f, config.sepolia.rpcUrl, 'eth_blockNumber', []))) };
  } catch {
    return { ok: false };
  }
}

async function fallback(f: typeof fetch, eth: Health['ethereum']): Promise<Health['fallback']> {
  if (!eth.ok) return { ready: false, reason: 'Ethereum Sepolia is unreachable from this device, so the Ethereum fallback cannot be used right now.' };
  const gate = configV2.ensGateV2;
  if (!gate) return { ready: false, reason: 'No EnsGate address is configured in this build.' };
  try {
    const code = await jsonRpc<Hex>(f, config.sepolia.rpcUrl, 'eth_getCode', [gate, 'latest']);
    return code && code !== '0x'
      ? { ready: true, reason: 'Ethereum is reachable and EnsGate is deployed, so a payment can go through Ethereum if the relayer or sequencer is down.' }
      : { ready: false, reason: 'EnsGate has no code on Ethereum Sepolia.' };
  } catch {
    return { ready: false, reason: 'Could not read EnsGate on Ethereum Sepolia.' };
  }
}

/** Checks the relayer, both chains and the Ethereum fallback in parallel. Never throws. */
export async function checkHealth(f: typeof fetch = globalThis.fetch): Promise<Health> {
  const now = Date.now();
  const [r, w, e] = await Promise.all([relayer(f), whitechain(f, now), ethereum(f)]);
  return { checkedAt: now, relayer: r, whitechain: w, ethereum: e, fallback: await fallback(f, e) };
}
