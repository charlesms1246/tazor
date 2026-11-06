/**
 * Due dates and reminders for invoices and payment links: the "Due in 3 days" label, a polite ready-to-send message,
 * WhatsApp / email links, and when this device last sent one. Nothing leaves the device until the person sends it.
 */

const DAY = 86_400_000;
export type DueTone = 'overdue' | 'today' | 'soon' | 'later';
export type Due = { text: string; tone: DueTone; days: number };

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Calendar days between today and the due date (local time): negative once overdue. `dueMs` is ms. */
export function dueIn(dueMs: number, now = Date.now()): Due {
  const days = Math.round((startOfDay(dueMs) - startOfDay(now)) / DAY);
  if (days < 0) return { text: `Overdue by ${-days} day${days === -1 ? '' : 's'}`, tone: 'overdue', days };
  if (days === 0) return { text: 'Due today', tone: 'today', days };
  return { text: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: days <= 3 ? 'soon' : 'later', days };
}

const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** A short, polite reminder with the amount, the due date and the pay link. */
export function reminderMessage(o: { to?: string | null; from: string; what: string; amount: string; dueMs: number | null; link: string; now?: number }): { subject: string; body: string } {
  const due = o.dueMs ? dueIn(o.dueMs, o.now) : null;
  const when = !o.dueMs ? '' : due!.tone === 'overdue' ? ` It was due on ${fmtDay(o.dueMs)}.` : due!.tone === 'today' ? ' It is due today.' : ` It is due on ${fmtDay(o.dueMs)}.`;
  const body = [
    `Hello${o.to ? ` ${o.to}` : ''},`,
    '',
    `A friendly reminder about ${o.what} from ${o.from} for ${o.amount} USDT.${when}`,
    '',
    `You can pay here in under a minute: ${o.link}`,
    '',
    'If you have already paid, please ignore this message. Thank you!',
    o.from,
  ].join('\n');
  return { subject: `Reminder: ${o.what} for ${o.amount} USDT${due?.tone === 'overdue' ? ' (overdue)' : ''}`, body };
}

export const whatsappHref = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const mailtoHref = (subject: string, body: string) => `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

// ---- when this device last sent a reminder, per invoice or link

const KEY = 'tazor.reminders.v1';
export const REMINDED = 'tazor:reminded';
const read = (): Record<string, number> => { try { const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
export const lastReminded = (key: string): number | null => read()[key.toLowerCase()] ?? null;
export function markReminded(key: string, at = Date.now()) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...read(), [key.toLowerCase()]: at }));
    globalThis.dispatchEvent?.(new Event(REMINDED));
  } catch { /* storage full */ }
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
