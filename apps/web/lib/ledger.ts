/**
 * One source for the money numbers every page shows, so Home, Invoices and Approvals never disagree.
 * Inputs are this device's invoices, payments and inbox plus what the chain says was paid; everything is deduplicated
 * by invoice hash and seen from ONE company (the selected one): invoices it sent, bills it has to pay.
 */
import type { ChainEvent } from './chain-history.ts';
import { isCompanyAccount, type Company } from './company.ts';
import type { PaymentRecord } from './export.ts';
import type { InboxItem, InboxStatus } from './inbox.ts';
import { invoiceHash } from './invoice.ts';
import type { StoredInvoice } from './invoices-store.ts';

export type Side = 'sent' | 'bills';
export type RowStatus = 'paid' | 'sent' | 'overdue';

export type LedgerRow = {
  /** The invoice hash, lowercase. */
  key: string;
  id: string;
  side: Side;
  /** The other party's account (buyer for sent invoices, supplier/payee for bills), when known. */
  counterparty: string | null;
  /** The other party's name when only a name is known (bills opened from a link on this device). */
  counterpartyName: string | null;
  amount: bigint;
  dueDate: number;
  status: RowStatus;
  link: string;
  stored: StoredInvoice | null;
  paidTx: string | null;
};

/** Chain InvoicePaid events by invoice hash (lowercase). */
export const chainPaidMap = (events: ChainEvent[]) =>
  new Map(events.filter((e) => e.kind === 'paid' && e.tx).map((e) => [e.subject.toLowerCase(), e]));

const hashOf = (s: StoredInvoice) => { try { return invoiceHash(s.invoice).toLowerCase(); } catch { return ''; } };

export function companyLedger(o: {
  company: Company; invoices: StoredInvoice[]; payments: PaymentRecord[]; inbox: InboxItem[]; chainPaid: Map<string, ChainEvent>; now?: number;
}): { sent: LedgerRow[]; bills: LedgerRow[] } {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const mine = (a: string) => isCompanyAccount(o.company, a);
  const paidOnDevice = new Map(o.payments.flatMap((p) => { try { return [[invoiceHash(p.invoice).toLowerCase(), p.txHash] as const]; } catch { return []; } }));
  const status = (key: string, due: number, inboxPaid = false): { status: RowStatus; paidTx: string | null } => {
    const tx = paidOnDevice.get(key) ?? o.chainPaid.get(key)?.tx ?? null;
    if (tx || inboxPaid) return { status: 'paid', paidTx: tx };
    return { status: due < now ? 'overdue' : 'sent', paidTx: null };
  };
  const rows = new Map<string, LedgerRow>();
  for (const s of o.invoices) {
    const key = hashOf(s);
    if (!key || rows.has(key)) continue;
    const i = s.invoice;
    const side: Side | null = mine(i.supplierAccount) || mine(i.payee) ? 'sent' : mine(i.buyerAccount) ? 'bills' : null;
    if (!side) continue;
    rows.set(key, {
      key, id: i.id, side, counterparty: side === 'sent' ? i.buyerAccount : i.payee, counterpartyName: side === 'bills' ? i.supplierName : null,
      amount: i.amount, dueDate: i.dueDate, link: s.link, stored: s, ...status(key, i.dueDate),
    });
  }
  // bills opened from a link on this device (not created here)
  for (const it of o.inbox) {
    if (it.kind !== 'invoice' || !it.account || !mine(it.account)) continue;
    const key = it.id.toLowerCase();
    if (rows.has(key)) continue;
    let amount = 0n;
    try { amount = BigInt(it.amount ?? '0'); } catch { /* unreadable amount */ }
    rows.set(key, {
      key, id: it.title.replace(/^Invoice /, ''), side: 'bills', counterparty: null, counterpartyName: it.counterparty ?? null,
      amount, dueDate: it.dueDate ?? 0, link: it.href, stored: null, ...status(key, it.dueDate ?? Number.MAX_SAFE_INTEGER, it.status === 'paid'),
    });
  }
  const all = [...rows.values()];
  return { sent: all.filter((r) => r.side === 'sent'), bills: all.filter((r) => r.side === 'bills') };
}

export function summarize(rows: LedgerRow[]) {
  const open = rows.filter((r) => r.status !== 'paid');
  return {
    count: rows.length,
    open: open.length,
    openTotal: open.reduce((s, r) => s + r.amount, 0n),
    overdue: rows.filter((r) => r.status === 'overdue').length,
    paid: rows.filter((r) => r.status === 'paid').length,
  };
}

// ---- approvals

export type ApprovalRow = InboxItem & { chain?: ChainEvent };

/**
 * The Approvals inbox for one company: this device's items for it (or without an account), plus what it paid on chain
 * that the device never saw, one row per invoice hash. A device item the chain shows paid is paid.
 */
export function approvalRows(items: InboxItem[], chainEvents: ChainEvent[], company: Company): { rows: ApprovalRow[]; paidOnChain: number } {
  const mine = (a?: string) => !a || isCompanyAccount(company, a);
  const paidByCompany = new Map<string, ChainEvent>();
  for (const e of chainEvents) {
    if (e.kind === 'paid' && e.payer && isCompanyAccount(company, e.payer) && !paidByCompany.has(e.subject.toLowerCase())) paidByCompany.set(e.subject.toLowerCase(), e);
  }
  const rows = new Map<string, ApprovalRow>();
  for (const it of items) {
    if (!mine(it.account)) continue;
    const key = it.id.toLowerCase();
    const c = paidByCompany.get(key);
    rows.set(key, c ? { ...it, status: 'paid' as InboxStatus, chain: c } : it);
  }
  for (const [key, e] of paidByCompany) {
    if (rows.has(key)) continue;
    rows.set(key, {
      id: e.subject, kind: 'invoice', title: e.title.split(' paid: ')[0], counterparty: undefined, amount: e.amount,
      href: '', createdAt: e.at, status: 'paid', approvals: 0, chain: e,
    });
  }
  return { rows: [...rows.values()], paidOnChain: paidByCompany.size };
}

export const countBy = (rows: ApprovalRow[], s: InboxStatus) => rows.filter((r) => r.status === s).length;
