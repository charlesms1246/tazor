/**
 * Hosted payment links for businesses without a website: /paylink/?m=&a=&ref=&n=[&ship=][&d=].
 * The link carries everything the checkout needs; nothing is stored anywhere.
 */
import { getAddress, isAddress, type Address } from 'viem';

/** Testnet cap per link. */
export const MAX_PAYLINK_USDT = 1000;
export const DEFAULT_SHIP_ABOVE = '100';
export const DEFAULT_DEADLINE_MIN = 30;

export type Paylink = {
  merchant: Address; amount: string; ref: string; name: string; shipAbove: string; deadlineMinutes: number;
  /** The date the business asks to be paid by (YYYY-MM-DD), or null. Shown to the customer; the order itself does not expire on it. */
  due: string | null;
};
export type PaylinkParse = { ok: true; link: Paylink } | { ok: false; error: string };

const AMOUNT = /^\d+(\.\d{1,6})?$/;
const clean = (v: string | null) => (v ?? '').trim();

/** Reads and checks a payment link's query; errors are written for the customer who opened it. */
export function parsePaylink(search: string): PaylinkParse {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const m = clean(q.get('m'));
  if (!m) return { ok: false, error: 'This payment link has no business address. Ask the business for a new link.' };
  if (!isAddress(m, { strict: false })) return { ok: false, error: 'This payment link has an invalid business address. Ask the business for a new link.' };
  const a = clean(q.get('a'));
  if (!AMOUNT.test(a) || Number(a) <= 0) return { ok: false, error: 'This payment link has no valid amount. Ask the business for a new link.' };
  if (Number(a) > MAX_PAYLINK_USDT) return { ok: false, error: `This payment link asks for ${a} USDT; on the test network a link can ask for at most ${MAX_PAYLINK_USDT} USDT.` };
  const ref = clean(q.get('ref'));
  if (!ref) return { ok: false, error: 'This payment link has no order number. Ask the business for a new link.' };
  if (ref.length > 64) return { ok: false, error: 'This payment link’s order number is too long (at most 64 characters).' };
  const name = clean(q.get('n')).slice(0, 80) || 'This business';
  const ship = clean(q.get('ship'));
  const shipAbove = AMOUNT.test(ship) ? ship : DEFAULT_SHIP_ABOVE;
  const d = Number(clean(q.get('d')));
  const deadlineMinutes = Number.isInteger(d) && d >= 5 && d <= 1440 ? d : DEFAULT_DEADLINE_MIN;
  const dueRaw = clean(q.get('due'));
  const due = isDueDate(dueRaw) ? dueRaw : null;
  return { ok: true, link: { merchant: getAddress(m), amount: a.replace(/^0+(?=\d)/, ''), ref, name, shipAbove, deadlineMinutes, due } };
}

/** The URL to share (WhatsApp, SMS, a QR on the counter); `origin` defaults to the current site. */
/** A due date as YYYY-MM-DD that is a real calendar day. */
export const isDueDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/** The due date as local-midnight ms (for "Due in N days"). */
export const dueMs = (due: string) => { const [y, m, d] = due.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

export function buildPaylink(l: { merchant: string; amount: string; ref: string; name?: string; ship?: string; deadlineMinutes?: number; due?: string }, origin = globalThis.location?.origin ?? ''): string {
  const q = new URLSearchParams({ m: l.merchant, a: l.amount, ref: l.ref });
  if (l.name) q.set('n', l.name);
  if (l.ship) q.set('ship', l.ship);
  if (l.deadlineMinutes) q.set('d', String(l.deadlineMinutes));
  if (l.due && isDueDate(l.due)) q.set('due', l.due);
  return `${origin}/paylink/?${q.toString()}`;
}

/** The receipt for a paid link: the order id, plus the order number (shown only if it matches the on-chain ref). */
export const receiptHref = (orderId: string, ref: string) => `/receipt/?order=${orderId}&ref=${encodeURIComponent(ref)}`;

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
