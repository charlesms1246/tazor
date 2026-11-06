/** A device-local activity log: each invoice, mandate or role change keeps its own timeline. */

export type EventKind =
  | 'created' | 'sent' | 'opened'
  | 'supplier-verified' | 'supplier-unverified'
  | 'approved' | 'policy-passed' | 'submitted' | 'paid'
  | 'fallback-sent' | 'fallback-delivered' | 'failed'
  | 'mandate-created' | 'collected' | 'mandate-cancelled'
  | 'role-granted' | 'role-synced' | 'role-revoked';

export type TimelineEvent = {
  subject: string;
  kind: EventKind;
  at: number;
  title: string;
  actor?: string;
  detail?: string;
  tx?: string;
  chain?: 'whitechain' | 'sepolia';
};

const KEY = 'tazor.events.v1';
const EVENT = 'tazor:events';
const MAX = 500;

function read(): TimelineEvent[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((e) => e && typeof e.subject === 'string' && typeof e.kind === 'string' && typeof e.at === 'number') : [];
  } catch {
    return [];
  }
}

const sameEvent = (a: TimelineEvent, b: TimelineEvent) =>
  a.subject.toLowerCase() === b.subject.toLowerCase() && a.kind === b.kind && (a.tx ?? '') === (b.tx ?? '') && (a.actor ?? '') === (b.actor ?? '');

/** Records an event once; a repeat of the same subject, kind, tx and actor is ignored. */
export function recordEvent(e: TimelineEvent): boolean {
  const list = read();
  if (list.some((x) => sameEvent(x, e))) return false;
  list.push(e);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    return false;
  }
  globalThis.dispatchEvent?.(new Event(EVENT));
  return true;
}

export const eventsFor = (subject: string): TimelineEvent[] =>
  read().filter((e) => e.subject.toLowerCase() === subject.toLowerCase()).sort((a, b) => a.at - b.at);

export const recentEvents = (n = 20): TimelineEvent[] => read().sort((a, b) => b.at - a.at).slice(0, n);

export const EVENTS_CHANGED = EVENT;

/** Seconds between two events of a subject, if both exist. */
export function elapsed(events: TimelineEvent[], from: EventKind, to: EventKind): number | null {
  const a = events.find((e) => e.kind === from);
  const b = events.find((e) => e.kind === to);
  return a && b && b.at >= a.at ? (b.at - a.at) / 1000 : null;
}
