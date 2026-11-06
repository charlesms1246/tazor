import type { Health } from '@/lib/health.ts';
import { plain } from '../../lib/human.ts';

export type HealthKey = 'relayer' | 'whitechain' | 'ethereum' | 'fallback' | 'rolesync' | 'mirror';
export type HealthRow = { key: HealthKey; name: string; tone: 'positive' | 'negative' | 'warning' | 'neutral'; status: string; detail: string };

const n = (v: number) => v.toLocaleString('en-US');

export function healthRows(h: Health): HealthRow[] {
  return [
    !h.relayer.configured
      ? { key: 'relayer', name: 'Relayer', tone: 'neutral', status: 'Not set', detail: 'No relayer on this device. Copy calldata and Send via Ethereum still work.' }
      : h.relayer.ok
        ? { key: 'relayer', name: 'Relayer', tone: 'positive', status: 'Up', detail: `${h.relayer.url}${h.relayer.ms !== undefined ? ` · ${h.relayer.ms} ms` : ''}` }
        : { key: 'relayer', name: 'Relayer', tone: 'negative', status: 'Unreachable', detail: `${h.relayer.url} did not answer. Payments can still be sent yourself or via Ethereum.` },
    h.whitechain.ok
      ? { key: 'whitechain', name: 'Whitechain Sepolia', tone: 'positive', status: 'Up', detail: `block ${n(h.whitechain.block ?? 0)}${h.whitechain.ageSec !== undefined ? ` · ${h.whitechain.ageSec} s ago` : ''}` }
      : { key: 'whitechain', name: 'Whitechain Sepolia', tone: 'negative', status: 'Unreachable', detail: 'The Whitechain RPC did not answer from this device.' },
    h.ethereum.ok
      ? { key: 'ethereum', name: 'Ethereum Sepolia', tone: 'positive', status: 'Up', detail: `block ${n(h.ethereum.block ?? 0)}` }
      : { key: 'ethereum', name: 'Ethereum Sepolia', tone: 'negative', status: 'Unreachable', detail: 'The Ethereum Sepolia RPC did not answer from this device.' },
    { key: 'fallback', name: 'Ethereum fallback', tone: h.fallback.ready ? 'positive' : 'warning', status: h.fallback.ready ? 'Ready' : 'Not ready', detail: h.fallback.reason },
    roleSyncRow(h),
    mirrorRow(h),
  ];
}

export const HEALTH_KEYS: HealthKey[] = ['relayer', 'whitechain', 'ethereum', 'fallback', 'rolesync', 'mirror'];

function roleSyncRow(h: Health): HealthRow {
  const name = 'Role sync';
  if (!h.relayer.configured || !h.relayer.ok || h.relayer.roleSync === undefined) {
    return { key: 'rolesync', name, tone: 'neutral', status: 'Unknown', detail: 'No relayer report. Anyone can still sync roles by submitting a proof to the role cache.' };
  }
  if (!h.relayer.roleSync) {
    return { key: 'rolesync', name, tone: 'warning', status: 'Not enabled', detail: 'This relayer doesn’t sync ENS roles. Anyone can still submit the proof to the role cache.' };
  }
  const n = h.relayer.watchRegistries?.length ?? 0;
  return { key: 'rolesync', name, tone: 'positive', status: `Enabled · ${n} ${n === 1 ? 'registry' : 'registries'}`, detail: 'The relayer syncs ENS role changes to Whitechain on demand, plus a daily sweep.' };
}

function mirrorRow(h: Health): HealthRow {
  const name = 'Revocation mirror';
  if (!h.relayer.configured || !h.relayer.ok || h.relayer.mirrorEnabled === undefined) {
    return { key: 'mirror', name, tone: 'neutral', status: 'Unknown', detail: 'No relayer report. A removal still takes effect on Whitechain at once; any company admin can also remove the role on ENS.' };
  }
  if (!h.relayer.mirrorEnabled) {
    return { key: 'mirror', name, tone: 'warning', status: 'Not authorized', detail: `Removals take effect on Whitechain at once but are not copied to ENS by this relayer${h.relayer.mirrorReason ? `: ${plain(h.relayer.mirrorReason)}` : '.'}` };
  }
  return { key: 'mirror', name, tone: 'positive', status: 'Enabled', detail: 'The relayer copies Whitechain removals to the company’s ENS name.' };
}
