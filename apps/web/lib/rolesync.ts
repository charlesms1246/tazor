import type { Address, Hex } from 'viem';
import type { Person } from './people.ts';

export type SyncStatus = 'in-sync' | 'synced' | 'pending-l1' | 'not-watched';
export type SyncResult = { status: SyncStatus; tx?: Hex; roles?: string };

/** Per-person progress shown on the Company page. */
export type SyncState =
  | { phase: 'syncing' }
  | { phase: 'synced'; tx?: Hex }
  | { phase: 'in-sync' }
  | { phase: 'pending'; retried: boolean }
  | { phase: 'not-watched' }
  | { phase: 'error'; message: string };

export const AUTO_SYNC_MAX = 3;
export const SYNC_STALE_SECONDS = 120;
export const PENDING_RETRY_MS = 60_000;

const STATUSES: SyncStatus[] = ['in-sync', 'synced', 'pending-l1', 'not-watched'];

/** POST {relayer}/sync for one approver of one company registry. Throws with the relayer's message on failure. */
export async function requestSync(relayerUrl: string, registry: Address, account: Address, f: typeof fetch = globalThis.fetch): Promise<SyncResult> {
  const res = await f(`${relayerUrl}/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registry, account }), signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `relayer returned ${res.status}`);
  if (!STATUSES.includes(body?.status)) throw new Error('unexpected /sync response');
  return { status: body.status, ...(typeof body.tx === 'string' ? { tx: body.tx as Hex } : {}), ...(body.roles !== undefined ? { roles: String(body.roles) } : {}) };
}

/** People worth syncing without being asked: out of sync, or "syncing" for longer than SYNC_STALE_SECONDS. */
export function needsAutoSync(p: Person): boolean {
  if (p.whitechain === 'out-of-sync') return true;
  return p.whitechain === 'syncing' && p.cacheAgeSec !== undefined && p.cacheAgeSec > SYNC_STALE_SECONDS;
}

export const pickAutoSync = (people: Person[], max = AUTO_SYNC_MAX): Person[] => people.filter(needsAutoSync).slice(0, max);

export function stateFromResult(r: SyncResult, retried = false): SyncState {
  if (r.status === 'synced') return { phase: 'synced', tx: r.tx };
  if (r.status === 'in-sync') return { phase: 'in-sync' };
  if (r.status === 'pending-l1') return { phase: 'pending', retried };
  return { phase: 'not-watched' };
}

export function syncText(s: SyncState): string {
  switch (s.phase) {
    case 'syncing': return 'Syncing from ENS…';
    case 'synced': return 'Synced';
    case 'in-sync': return 'Already in sync';
    case 'pending': return s.retried
      ? 'Whitechain hasn’t seen the ENS change yet; try Sync now again in a minute'
      : 'Waiting for Whitechain to see the ENS change (~1 min)';
    case 'not-watched': return 'Role sync isn’t enabled for this company’s registry';
    case 'error': return `Sync failed: ${s.message}`;
  }
}

/** Reads {roleSync, watchRegistries} from a relayer's /health; null if unreachable or not reported. */
export async function relayerRoleSync(relayerUrl: string, f: typeof fetch = globalThis.fetch): Promise<{ enabled: boolean; registries: string[] } | null> {
  try {
    const res = await f(`${relayerUrl}/health`, { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    if (!res.ok || typeof body?.roleSync !== 'boolean') return null;
    return { enabled: body.roleSync, registries: Array.isArray(body.watchRegistries) ? body.watchRegistries.map(String) : [] };
  } catch {
    return null;
  }
}
