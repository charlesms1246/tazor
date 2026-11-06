/**
 * Reject / Hold decisions on approval items, with a reason. Saved on THIS DEVICE ONLY (localStorage) until Tazor has a
 * shared backend; the UI labels them "local". Nothing here touches the chain: a held or rejected invoice can still be
 * approved by someone else, so this is a working note for the person approving, not a control.
 */
export type Decision = { kind: 'hold' | 'reject'; reason: string; at: number };

const KEY = 'tazor.decisions.v1';
export const DECISIONS_CHANGED = 'tazor:decisions';

export function loadDecisions(): Record<string, Decision> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, Decision> = {};
    for (const [k, d] of Object.entries(v as Record<string, Decision>)) {
      if ((d?.kind === 'hold' || d?.kind === 'reject') && typeof d.reason === 'string' && typeof d.at === 'number') out[k.toLowerCase()] = d;
    }
    return out;
  } catch {
    return {};
  }
}

function save(all: Record<string, Decision>): boolean {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
    globalThis.dispatchEvent?.(new Event(DECISIONS_CHANGED));
    return true;
  } catch {
    return false;
  }
}

/** Holds or rejects an item; a reason is required (it is what a colleague reads later). */
export function decide(id: string, kind: Decision['kind'], reason: string, now = Date.now()): Decision {
  const r = reason.trim();
  if (!r) throw new Error(kind === 'hold' ? 'Say why you are holding it.' : 'Say why you are rejecting it.');
  if (r.length > 280) throw new Error('Keep the reason under 280 characters.');
  const d = { kind, reason: r, at: now };
  save({ ...loadDecisions(), [id.toLowerCase()]: d });
  return d;
}

/** Clears a hold or rejection (back to Needs approval). */
export function release(id: string): void {
  const all = loadDecisions();
  delete all[id.toLowerCase()];
  save(all);
}
