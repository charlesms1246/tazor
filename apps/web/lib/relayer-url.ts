import { config } from './config.ts';

const KEY = 'tazor.relayer.v1';

/** https:// (any host) or http:// on localhost / 127.0.0.1; no credentials; trailing slashes stripped. */
export function normalizeRelayerUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The relayer chosen on this device (Settings), else the build-time default (may be empty: no relayer). */
export function getRelayerUrl(): string {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    const n = v ? normalizeRelayerUrl(v) : null;
    if (n) return n;
  } catch { /* storage unavailable */ }
  return config.relayerUrl;
}

/** Saves a validated override, or clears it with null. Returns false if invalid or storage is unavailable. */
export function setRelayerUrl(url: string | null): boolean {
  try {
    if (url === null) {
      globalThis.localStorage?.removeItem(KEY);
      return true;
    }
    const n = normalizeRelayerUrl(url);
    if (!n) return false;
    globalThis.localStorage.setItem(KEY, n);
    return true;
  } catch {
    return false;
  }
}

export const hasRelayerOverride = (): boolean => {
  try { return !!globalThis.localStorage?.getItem(KEY); } catch { return false; }
};
