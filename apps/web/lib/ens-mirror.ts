/**
 * Whether a Whitechain revocation has reached the company's ENS registry on Sepolia ("Mirrored to ENS"),
 * and an on-demand request to the relayer's POST /mirror. Both never throw.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, type Address } from 'viem';
import { config } from './config.ts';

export const ROLE_APPROVER = 1n << 64n;
const rolesAbi = parseAbi(['function roles(uint256 resource, address account) view returns (uint256)']);
type Fetch = typeof fetch;

export type EnsMirrorState = 'mirrored' | 'still-on-ens' | 'unknown';

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await run(c.signal); } finally { clearTimeout(t); }
}

/** 'mirrored' when the person no longer holds APPROVER on the company's ENS registry. */
export async function ensApproverState(registry: string, target: string, opts: { f?: Fetch; rpcUrl?: string; ms?: number } = {}): Promise<EnsMirrorState> {
  if (!isAddress(registry, { strict: false }) || !isAddress(target, { strict: false })) return 'unknown';
  const f = opts.f ?? globalThis.fetch;
  try {
    return await withTimeout(opts.ms ?? 5000, async (signal) => {
      const data = encodeFunctionData({ abi: rolesAbi, functionName: 'roles', args: [0n, getAddress(target)] });
      const res = await f(opts.rpcUrl ?? config.sepolia.rpcUrl, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: getAddress(registry), data }, 'latest'] }),
      });
      const j = (await res.json()) as { result?: `0x${string}` };
      if (!res.ok || typeof j.result !== 'string') return 'unknown';
      const roles = decodeFunctionResult({ abi: rolesAbi, functionName: 'roles', data: j.result }) as bigint;
      return (roles & ROLE_APPROVER) === 0n ? 'mirrored' : 'still-on-ens';
    });
  } catch {
    return 'unknown';
  }
}

export type MirrorRequest = { status: string; tx?: string; registry?: Address; reason?: string; error?: string };

/** Asks the relayer to mirror one revocation now. Statuses: mirrored, already-mirrored, not-revoked, not-watched, not-authorized, not-a-company, or error. */
export async function requestMirror(relayerUrl: string, account: string, target: string, opts: { f?: Fetch; ms?: number } = {}): Promise<MirrorRequest> {
  const f = opts.f ?? globalThis.fetch;
  try {
    return await withTimeout(opts.ms ?? 30_000, async (signal) => {
      const res = await f(`${relayerUrl.replace(/\/+$/, '')}/mirror`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, target }),
      });
      const j = (await res.json().catch(() => ({}))) as MirrorRequest;
      if (res.status === 404) return { status: 'error', error: 'this relayer does not mirror revocations' };
      if (!res.ok) return { status: 'error', error: j.error ?? `relayer returned ${res.status}` };
      return j;
    });
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e) };
  }
}

/** Short UI label for a revocation row. */
export const mirrorLabel = (s: EnsMirrorState): string =>
  s === 'mirrored' ? 'Mirrored to ENS' : s === 'still-on-ens' ? 'Not yet mirrored to ENS' : 'ENS status unknown';
