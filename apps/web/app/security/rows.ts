import type { Health } from '@/lib/health.ts';

export type HealthKey = 'relayer' | 'whitechain' | 'ethereum' | 'fallback';
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
  ];
}

export const HEALTH_KEYS: HealthKey[] = ['relayer', 'whitechain', 'ethereum', 'fallback'];
