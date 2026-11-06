/**
 * "Simulate relayer down": points this device at a relayer address that never answers, so every page sees exactly
 * what it sees when Tazor's servers are down. The previous choice is kept and restored by "Turn back on".
 */
import { getRelayerUrl, hasRelayerOverride, setRelayerUrl } from './relayer-url.ts';

export const OFFLINE_RELAYER = 'https://relayer-offline.invalid';
const KEY = 'tazor.relayer-off.v1';
export const RELAYER_OFF_EVENT = 'tazor:relayer-off';

type Saved = { previous: string | null };

export function isRelayerSimulatedOff(): boolean {
  try { return getRelayerUrl() === OFFLINE_RELAYER && globalThis.localStorage?.getItem(KEY) !== null; } catch { return false; }
}

export function simulateRelayerDown(): boolean {
  if (isRelayerSimulatedOff()) return true;
  try {
    const saved: Saved = { previous: hasRelayerOverride() ? getRelayerUrl() : null };
    globalThis.localStorage.setItem(KEY, JSON.stringify(saved));
    if (!setRelayerUrl(OFFLINE_RELAYER)) return false;
  } catch { return false; }
  globalThis.dispatchEvent?.(new Event(RELAYER_OFF_EVENT));
  return true;
}

/** Restores the relayer this device used before the simulation (or the build default). */
export function restoreRelayer(): void {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Saved | null;
    setRelayerUrl(saved?.previous ?? null);
    globalThis.localStorage?.removeItem(KEY);
  } catch { setRelayerUrl(null); }
  globalThis.dispatchEvent?.(new Event(RELAYER_OFF_EVENT));
}
