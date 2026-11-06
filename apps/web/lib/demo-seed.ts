/**
 * Loads the live testnet history (lib/demo-data.ts) into this device's stores through their normal APIs,
 * and removes exactly what it added. A manifest under tazor.demo.v1 lists every record the seed created,
 * so records that were already here (for example a real payment made on this device) are never touched.
 */
import { getAddress, type Address } from 'viem';
import { invoiceHash, parseInvoice, type Invoice } from './invoice.ts';
import { encodeInvoiceLink } from './invoice-link.ts';
import { loadInvoices, saveInvoice } from './invoices-store.ts';
import { appendPayment, loadMandates, loadPayments, saveMandate } from './storage.ts';
import { recordEvent, EVENTS_CHANGED, type TimelineEvent } from './events.ts';
import { loadInbox, upsertInbox, INBOX_CHANGED } from './inbox.ts';
import {
  DEMO_ACCOUNTS, DEMO_DUE_DATE, DEMO_FALLBACK_V2, DEMO_INVOICES, DEMO_MANDATES, DEMO_MANDATE_V2, DEMO_MEMO, DEMO_PEOPLE,
  DEMO_ROLES, DEMO_RUNS, DEMO_TOKEN, type DemoInvoice,
} from './demo-data.ts';

const MANIFEST = 'tazor.demo.v1';
export const DEMO_CHANGED = 'tazor:demo';
const SOURCE = 'live testnet run, 6 Nov 2026';

type Manifest = { loadedAt: number; invoices: string[]; payments: string[]; events: string[]; inbox: string[]; mandates: string[] };

const NAMES: Record<keyof typeof DEMO_PEOPLE, string> = { priya: 'Priya', cfo: 'CFO', ravi: 'Ravi', meera: 'Meera' };

const ls = () => globalThis.localStorage;

function readManifest(): Manifest | null {
  try {
    const v = JSON.parse(ls()?.getItem(MANIFEST) ?? 'null');
    return v && Array.isArray(v.invoices) && Array.isArray(v.payments) && Array.isArray(v.events) && Array.isArray(v.inbox) && Array.isArray(v.mandates) ? v : null;
  } catch {
    return null;
  }
}

const notify = () => { for (const e of [EVENTS_CHANGED, INBOX_CHANGED, DEMO_CHANGED]) globalThis.dispatchEvent?.(new Event(e)); };

/** The Invoice exactly as the live run built it (make-payment.ts), so it hashes to the logged invoiceHash. */
export function demoInvoice(d: DemoInvoice): Invoice {
  const supplier = DEMO_ACCOUNTS[d.supplier];
  return parseInvoice({
    id: d.id, supplierName: d.supplierName, supplierAccount: supplier, payee: supplier, buyerAccount: DEMO_ACCOUNTS[d.buyer],
    token: DEMO_TOKEN, amount: d.amount, dueDate: DEMO_DUE_DATE,
    lines: [{ description: d.description, quantity: '1', unitPrice: d.amount }], memo: DEMO_MEMO,
  });
}

const fmt = (base: string) => (Number(base) / 1e6).toFixed(2);
const eventKey = (e: Pick<TimelineEvent, 'subject' | 'kind' | 'tx' | 'actor'>) => `${e.subject.toLowerCase()}|${e.kind}|${e.tx ?? ''}|${e.actor ?? ''}`;
const ms = (s: number) => s * 1000;

/** Every timeline event the demo adds, in time order. */
export function demoEvents(): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const d of DEMO_INVOICES) {
    const subject = d.invoiceHash.toLowerCase();
    const who = NAMES[d.approver];
    out.push({ subject, kind: 'created', at: ms(d.signedAt), title: `${d.id} created by ${d.supplierName}`, actor: d.supplierName, detail: `${fmt(d.amount)} USDT · ${SOURCE}` });
    out.push({ subject, kind: 'approved', at: ms(d.signedAt), title: `${d.id} approved by ${who}`, actor: who, detail: SOURCE });
    if (d.fallback) {
      out.push({ subject, kind: 'fallback-sent', at: ms(d.fallback.l1At), title: `${d.id} sent through Ethereum`, detail: 'EnsGate on Sepolia', tx: d.fallback.l1Tx, chain: 'sepolia' });
      out.push({ subject, kind: 'fallback-delivered', at: ms(d.fallback.l2At), title: `${d.id} delivered via Ethereum in ${d.fallback.seconds} s`, detail: 'OptimismPortal deposit', tx: d.fallback.l2Tx, chain: 'whitechain' });
    }
    if (d.paid) out.push({ subject, kind: 'paid', at: ms(d.paid.at), title: d.paid.title, detail: d.paid.detail, tx: d.paid.tx, chain: 'whitechain' });
    if (d.refused) out.push({ subject, kind: 'failed', at: ms(d.refused.at), title: d.refused.title, detail: d.refused.detail });
  }
  for (const m of [...DEMO_MANDATES, DEMO_MANDATE_V2]) {
    out.push({ subject: m.id.toLowerCase(), kind: 'mandate-created', at: ms(m.created.at), title: m.created.title, actor: 'Acme Industries', tx: m.created.tx, chain: 'whitechain', detail: SOURCE });
    out.push({ subject: m.id.toLowerCase(), kind: 'collected', at: ms(m.collected.at), title: m.collected.title, actor: 'Bluejay Logistics', tx: m.collected.tx, chain: 'whitechain', detail: SOURCE });
  }
  for (const r of DEMO_RUNS) out.push({ subject: r.tx.toLowerCase(), kind: 'paid', at: ms(r.at), title: r.title, detail: r.detail, tx: r.tx, chain: 'whitechain' });
  const f = DEMO_FALLBACK_V2;
  out.push({ subject: f.l2Tx.toLowerCase(), kind: 'fallback-sent', at: ms(f.l1At), title: 'Payment v2 sent through Ethereum', detail: 'EnsGate v2 on Sepolia, 0.30 USDT', tx: f.l1Tx, chain: 'sepolia' });
  out.push({ subject: f.l2Tx.toLowerCase(), kind: 'fallback-delivered', at: ms(f.l2At), title: `Payment v2 delivered via Ethereum in ${f.seconds} s`, detail: 'payFromL1 on Whitechain', tx: f.l2Tx, chain: 'whitechain' });
  for (const r of DEMO_ROLES) {
    out.push({ subject: getAddress(DEMO_PEOPLE[r.subject]), kind: r.kind, at: ms(r.at), title: r.title, actor: NAMES[r.subject], detail: r.detail ?? SOURCE, tx: r.tx, chain: r.chain });
  }
  return out.sort((a, b) => a.at - b.at);
}

export const isDemoLoaded = (): boolean => readManifest() !== null;

export const demoCounts = () => ({
  invoices: DEMO_INVOICES.length,
  payments: DEMO_INVOICES.filter((d) => d.paid).length,
  fallbacks: DEMO_INVOICES.filter((d) => d.fallback).length + 1,
});

/** Adds the demo records. Safe to call twice: anything already present is skipped and not claimed. */
export async function seedDemo(origin: string = globalThis.location?.origin ?? 'https://taz0r.eth.limo'): Promise<boolean> {
  if (isDemoLoaded()) return true;
  const m: Manifest = { loadedAt: Math.floor(Date.now() / 1000), invoices: [], payments: [], events: [], inbox: [], mandates: [] };

  const built = DEMO_INVOICES.map((d) => ({ d, invoice: demoInvoice(d) }));
  for (const { d, invoice } of built) {
    if (invoiceHash(invoice).toLowerCase() !== d.invoiceHash.toLowerCase()) throw new Error(`${d.id} does not rebuild to its logged invoiceHash`);
  }
  try {
    return await seedInto(m, built, origin);
  } finally {
    try { ls()?.setItem(MANIFEST, JSON.stringify(m)); } catch { /* storage unavailable */ }
    notify();
  }
}

async function seedInto(m: Manifest, built: { d: DemoInvoice; invoice: Invoice }[], origin: string): Promise<boolean> {
  const existing = new Map(loadInvoices().map((s) => [invoiceHash(s.invoice).toLowerCase(), s.link]));
  const paidTx = new Set(loadPayments().map((p) => p.txHash.toLowerCase()));
  const inboxIds = new Set(loadInbox().map((i) => i.id.toLowerCase()));

  for (const { d, invoice } of built) {
    const h = d.invoiceHash.toLowerCase();
    let link = existing.get(h);
    if (!link) {
      link = await encodeInvoiceLink(invoice, origin);
      if (!saveInvoice({ invoice, link, createdAt: d.signedAt })) return false;
      m.invoices.push(link);
    }
    if (d.paid && !paidTx.has(d.paid.tx.toLowerCase())) {
      appendPayment({ invoice, txHash: d.paid.tx, blockTimestamp: d.paid.at });
      m.payments.push(d.paid.tx.toLowerCase());
    }
    if (!inboxIds.has(h)) {
      upsertInbox({
        id: h, kind: 'invoice', title: `Invoice ${d.id}`, counterparty: d.supplierName, amount: invoice.amount.toString(), dueDate: invoice.dueDate,
        href: link, account: invoice.buyerAccount as Address, createdAt: d.signedAt * 1000,
        status: d.paid ? 'paid' : 'needs-approval', approvals: d.paid ? 1 : 0, required: 1,
      });
      m.inbox.push(h);
    }
  }

  const mandates = new Set(loadMandates().map((x) => x.id.toLowerCase()));
  for (const md of DEMO_MANDATES) {
    if (mandates.has(md.id.toLowerCase())) continue;
    saveMandate({ id: md.id, label: md.label });
    m.mandates.push(md.id.toLowerCase());
  }

  for (const e of demoEvents()) if (recordEvent(e)) m.events.push(eventKey(e));
  return true;
}

function filterKey<T>(key: string, keep: (x: T) => boolean): void {
  try {
    const v = JSON.parse(ls()?.getItem(key) ?? '[]');
    if (Array.isArray(v)) ls()?.setItem(key, JSON.stringify(v.filter(keep)));
  } catch { /* leave a corrupt store alone */ }
}

/** Removes only the records listed in the manifest, then the manifest. */
export function clearDemo(): void {
  const m = readManifest();
  if (!m) return;
  const links = new Set(m.invoices);
  const txs = new Set(m.payments);
  const events = new Set(m.events);
  const inbox = new Set(m.inbox);
  const mandates = new Set(m.mandates);
  filterKey<{ link: string }>('tazor.invoices.v1', (r) => !links.has(r.link));
  filterKey<{ txHash: string }>('tazor.payments.v1', (r) => !txs.has(String(r.txHash).toLowerCase()));
  filterKey<TimelineEvent>('tazor.events.v1', (e) => !events.has(eventKey(e)));
  filterKey<{ id: string }>('tazor.inbox.v1', (i) => !inbox.has(String(i.id).toLowerCase()));
  filterKey<{ id: string }>('tazor.mandates.v1', (x) => !mandates.has(String(x.id).toLowerCase()));
  try { ls()?.removeItem(MANIFEST); } catch { /* storage unavailable */ }
  notify();
}
