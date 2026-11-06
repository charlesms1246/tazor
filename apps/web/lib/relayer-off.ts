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

/** How long pages wait for the relayer to submit a transaction and see it confirmed. */
export const RELAYER_WRITE_TIMEOUT_MS = 60_000;

/** A plain explanation of why a request to the relayer failed before any answer came back. */
export function relayerFailure(e: unknown, fallback: string): Error {
  if (isRelayerSimulatedOff()) {
    return new Error(`Relayer unreachable: the relayer is switched off on this device (Security & settings → "Turn back on"). ${fallback}`);
  }
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`Relayer unreachable: it didn't answer within ${RELAYER_WRITE_TIMEOUT_MS / 1000} s. It may still have sent the transaction, so check again in a minute before retrying. ${fallback}`);
  }
  return new Error(`Relayer unreachable: the network request failed (offline, or blocked by a browser extension). ${fallback}`);
}
