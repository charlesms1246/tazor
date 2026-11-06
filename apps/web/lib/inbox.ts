/** Items waiting for this device's approver: invoices opened here, payment runs, mandates and role changes. */

export type InboxKind = 'invoice' | 'run' | 'mandate' | 'role';
export type InboxStatus = 'needs-approval' | 'approved' | 'paid' | 'declined';

export type InboxItem = {
  id: string;
  kind: InboxKind;
  title: string;
  counterparty?: string;
  amount?: string;
  dueDate?: number;
  href: string;
  createdAt: number;
  status: InboxStatus;
  approvals: number;
  required?: number;
  account?: string;
};

const KEY = 'tazor.inbox.v1';
const EVENT = 'tazor:inbox';

export function loadInbox(): InboxItem[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((i) => i && typeof i.id === 'string' && typeof i.href === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds or updates an item by id; existing fields are kept unless the patch sets them. A paid item never goes back to pending. */
export function upsertInbox(item: Partial<InboxItem> & Pick<InboxItem, 'id'>): InboxItem | null {
  const list = loadInbox();
  const i = list.findIndex((x) => x.id.toLowerCase() === item.id.toLowerCase());
  const prev = i >= 0 ? list[i] : null;
  const merged = { ...(prev ?? { kind: 'invoice', title: item.id, href: '/', createdAt: Date.now(), status: 'needs-approval', approvals: 0 }), ...item } as InboxItem;
  if (prev?.status === 'paid') merged.status = 'paid';
  if (i >= 0) list[i] = merged; else list.push(merged);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    return null;
  }
  globalThis.dispatchEvent?.(new Event(EVENT));
  return merged;
}

export const pendingInbox = (list = loadInbox()) => list.filter((i) => i.status === 'needs-approval');
export const INBOX_CHANGED = EVENT;
