import { useEffect, useState } from 'react';
import { invoiceHash, type Invoice } from './invoice.ts';
import { eventsFor, EVENTS_CHANGED, recordEvent, type EventKind, type TimelineEvent } from './events.ts';
import { companyByAccount } from './company.ts';
import { nameOf } from './activity.ts';
import type { InboxItem } from './inbox.ts';

/** Timeline subject for an invoice: its canonical hash, lowercase. */
export const subjectOf = (i: Invoice): string => invoiceHash(i).toLowerCase();

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** A company name for an account if this app knows it, else the short address. */
export const partyName = (a: string): string => companyByAccount(a)?.name ?? (/^0x[0-9a-fA-F]{40}$/.test(a) ? nameOf(a as `0x${string}`) : null) ?? shortAddr(a);

export type Step = { done: EventKind[]; label: string };

/** What a payment link still has to go through, in order. */
export const INVOICE_STEPS: Step[] = [
  { done: ['opened'], label: 'Customer opens the link' },
  { done: ['approved'], label: 'Waiting for approval' },
  { done: ['submitted', 'fallback-sent'], label: 'Payment submitted (relayer, calldata or Ethereum)' },
  { done: ['paid', 'fallback-delivered'], label: 'Settles on Whitechain' },
];

export const RUN_STEPS: Step[] = [
  { done: ['approved'], label: 'Waiting for approval' },
  { done: ['submitted'], label: 'Run submitted' },
  { done: ['paid'], label: 'Settles on Whitechain' },
];

/** Labels of the steps not reached yet; a later step that happened (e.g. paid elsewhere) counts the earlier ones as done. */
export function pendingSteps(events: Pick<TimelineEvent, 'kind'>[], steps: Step[]): string[] {
  const kinds = new Set(events.map((e) => e.kind));
  let last = -1;
  steps.forEach((s, i) => { if (s.done.some((k) => kinds.has(k))) last = i; });
  return steps.slice(last + 1).map((s) => s.label);
}

/** Inbox fields for an invoice opened on this device (status is left to the caller). */
export const inboxForInvoice = (i: Invoice, href: string): Partial<InboxItem> & Pick<InboxItem, 'id'> => ({
  id: subjectOf(i), kind: 'invoice', title: `Invoice ${i.id}`, counterparty: i.supplierName,
  amount: i.amount.toString(), dueDate: i.dueDate, href, account: i.buyerAccount,
});

/** Records the first sighting of an invoice on this device: "created" (at its issue date) if never seen, then "opened". */
export function recordOpened(i: Invoice, issuedMs: number | null, now = Date.now()): void {
  const subject = subjectOf(i);
  if (eventsFor(subject).length === 0) {
    recordEvent({ subject, kind: 'created', at: Math.min(issuedMs ?? now, now), title: `${i.id} created by ${i.supplierName}`, actor: i.supplierName });
  }
  recordEvent({ subject, kind: 'opened', at: now, title: `${i.id} opened by ${partyName(i.buyerAccount)}`, actor: partyName(i.buyerAccount) });
}

/** The events of a subject, kept in sync with this device's log. */
export function useEvents(subject: string | null | undefined): TimelineEvent[] {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  useEffect(() => {
    if (!subject) { setEvents([]); return; }
    const sync = () => setEvents(eventsFor(subject));
    sync();
    globalThis.addEventListener(EVENTS_CHANGED, sync);
    return () => globalThis.removeEventListener(EVENTS_CHANGED, sync);
  }, [subject]);
  return events;
}
