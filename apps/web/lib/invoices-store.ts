import { getAddress, isAddress, parseUnits, type Address } from 'viem';
import { WHITECHAIN_SEPOLIA_USDT } from './invoice-auth.ts';
import { canonicalInvoiceJson, invoiceHash, parseInvoice, type Invoice } from './invoice.ts';
import type { PaymentRecord } from './export.ts';

export type LineForm = { description: string; quantity: string; unitPrice: string };
export type InvoiceForm = {
  customer: string;
  payee: string;
  supplierName: string;
  supplierAccount: string;
  lines: LineForm[];
  dueDate: string;
  memo: string;
};

const USDT_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const QTY_RE = /^[1-9]\d*$/;

/** Base units (6 decimals) for a USDT amount typed by a person, or null if it is not a plain decimal. */
export function parseUsdt(v: string): bigint | null {
  const t = v.trim();
  return USDT_RE.test(t) ? parseUnits(t, 6) : null;
}

export const lineTotal = (l: LineForm): bigint | null => {
  const price = parseUsdt(l.unitPrice);
  return QTY_RE.test(l.quantity.trim()) && price !== null ? BigInt(l.quantity.trim()) * price : null;
};

/** Sum of the lines that are complete so far (for the live total). */
export const formTotal = (f: InvoiceForm): bigint => f.lines.reduce((s, l) => s + (lineTotal(l) ?? 0n), 0n);

export const newInvoiceId = (now = new Date(), rand = Math.random) =>
  `INV-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(rand() * 0x10000).toString(16).toUpperCase().padStart(4, '0')}`;

/** Validates the form and returns an Invoice that the Pay page accepts, or the first problem found. */
export function buildInvoice(f: InvoiceForm, id: string): { invoice: Invoice } | { error: string } {
  const address = (v: string, label: string): Address | string => (isAddress(v.trim()) ? getAddress(v.trim()) : `${label} must be a Whitechain address (0x…)`);
  const customer = address(f.customer, 'Customer company account');
  if (!customer.startsWith('0x')) return { error: customer };
  const payee = address(f.payee, 'Payee');
  if (!payee.startsWith('0x')) return { error: payee };
  const supplier = f.supplierAccount.trim() ? address(f.supplierAccount, 'Supplier account') : payee;
  if (!supplier.startsWith('0x')) return { error: supplier };
  if (!f.supplierName.trim()) return { error: 'Enter the supplier name.' };
  if (f.lines.length === 0) return { error: 'Add at least one line.' };
  const lines = [];
  for (const [i, l] of f.lines.entries()) {
    if (!l.description.trim()) return { error: `Line ${i + 1}: enter a description.` };
    if (!QTY_RE.test(l.quantity.trim())) return { error: `Line ${i + 1}: quantity must be a whole number of at least 1.` };
    const price = parseUsdt(l.unitPrice);
    if (price === null || price === 0n) return { error: `Line ${i + 1}: unit price must be a USDT amount above 0 (up to 6 decimals).` };
    lines.push({ description: l.description.trim(), quantity: BigInt(l.quantity.trim()), unitPrice: price });
  }
  const due = Math.floor(new Date(`${f.dueDate}T00:00:00Z`).getTime() / 1000);
  if (!f.dueDate || !Number.isSafeInteger(due) || due <= 0) return { error: 'Pick a due date.' };
  try {
    const invoice = parseInvoice({
      id, supplierName: f.supplierName.trim(), supplierAccount: supplier, payee, buyerAccount: customer,
      token: WHITECHAIN_SEPOLIA_USDT, amount: lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0n),
      dueDate: due, lines, memo: f.memo.trim(),
    });
    return { invoice };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- invoices created on this device

const KEY = 'tazor.invoices.v1';
export type StoredInvoice = { invoice: Invoice; link: string; createdAt: number };
type Raw = { invoice: string; link: string; createdAt: number };

export function loadInvoices(): StoredInvoice[] {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]') as Raw[];
    return list.flatMap((r) => {
      try { return [{ invoice: parseInvoice(JSON.parse(r.invoice)), link: r.link, createdAt: r.createdAt }]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function saveInvoice(s: StoredInvoice): boolean {
  try {
    const list = (JSON.parse(globalThis.localStorage.getItem(KEY) ?? '[]') as Raw[]).filter((r) => r.link !== s.link);
    list.unshift({ invoice: canonicalInvoiceJson(s.invoice), link: s.link, createdAt: s.createdAt });
    globalThis.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** "paid" if a payment recorded on this device is for the same invoice (same canonical hash). */
export function invoiceStatus(invoice: Invoice, payments: PaymentRecord[]): 'paid' | 'sent' {
  const h = invoiceHash(invoice);
  return payments.some((p) => { try { return invoiceHash(p.invoice) === h; } catch { return false; } }) ? 'paid' : 'sent';
}
