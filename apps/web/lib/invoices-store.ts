import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { WHITECHAIN_SEPOLIA_USDT } from './invoice-auth.ts';
import { canonicalInvoiceJson, invoiceHash, parseInvoice, type Invoice, type InvoiceLine } from './invoice.ts';
import type { PaymentRecord } from './export.ts';
import { cleanGst, readGst, type GstMeta } from './gst.ts';

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

// ---- tax as a final line item (the invoice amount stays the sum of its lines)

const RATE_RE = /^(0|[1-9]\d{0,2})(\.\d{1,2})?$/;
const TAX_DESC_RE = /^(.*\S) (\d{1,3}(?:\.\d{1,2})?)%$/;

/** Tax rate in basis points (0.01 %), or null unless it is a plain number from 0 to 100 with up to 2 decimals. */
export function parseRate(v: string): bigint | null {
  const t = v.trim();
  if (!RATE_RE.test(t)) return null;
  const bp = parseUnits(t, 2);
  return bp <= 10_000n ? bp : null;
}

/** Tax in base units, rounded half-up: round(subtotal × bp / 10 000). */
export const taxFor = (subtotal: bigint, bp: bigint): bigint => (subtotal * bp + 5_000n) / 10_000n;

export type TaxInfo = { label: string; rate: string; amount: bigint };

/** The tax for a draft (complete lines only), or null when there is no positive tax to add. */
export function draftTax(f: InvoiceForm, rateText: string, label: string): TaxInfo | null {
  const bp = parseRate(rateText);
  if (bp === null || bp === 0n) return null;
  const amount = taxFor(formTotal(f), bp);
  return amount > 0n ? { label: label.trim() || 'Tax', rate: formatUnits(bp, 2), amount } : null;
}

/** The form with a final "<label> <rate>%" line (quantity 1) when the tax is above zero. */
export function withTax(f: InvoiceForm, rateText: string, label: string): InvoiceForm {
  const tax = draftTax(f, rateText, label);
  if (!tax) return f;
  return { ...f, lines: [...f.lines, { description: `${tax.label} ${tax.rate}%`, quantity: '1', unitPrice: formatUnits(tax.amount, 6) }] };
}

/** Splits a final tax line (as written by withTax) back off an invoice's lines; otherwise tax is null. */
export function splitTax(lines: InvoiceLine[]): { lines: InvoiceLine[]; tax: TaxInfo | null } {
  const last = lines.at(-1);
  const m = last && lines.length > 1 && last.quantity === 1n ? TAX_DESC_RE.exec(last.description) : null;
  const bp = m ? parseRate(m[2]) : null;
  if (!last || !m || bp === null || bp === 0n) return { lines, tax: null };
  const rest = lines.slice(0, -1);
  const subtotal = rest.reduce((s, l) => s + l.quantity * l.unitPrice, 0n);
  return taxFor(subtotal, bp) === last.unitPrice ? { lines: rest, tax: { label: m[1], rate: m[2], amount: last.unitPrice } } : { lines, tax: null };
}

// ---- invoices created on this device

const KEY = 'tazor.invoices.v1';
/** `gst` is display-only metadata (see lib/gst.ts); it is not part of the signed invoice. */
export type StoredInvoice = { invoice: Invoice; link: string; createdAt: number; gst?: GstMeta | null };
type Raw = { invoice: string; link: string; createdAt: number; gst?: unknown };

export function loadInvoices(): StoredInvoice[] {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]') as Raw[];
    return list.flatMap((r) => {
      try { return [{ invoice: parseInvoice(JSON.parse(r.invoice)), link: r.link, createdAt: r.createdAt, gst: readGst(r.gst) }]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function saveInvoice(s: StoredInvoice): boolean {
  try {
    const list = (JSON.parse(globalThis.localStorage.getItem(KEY) ?? '[]') as Raw[]).filter((r) => r.link !== s.link);
    const gst = cleanGst(s.gst);
    list.unshift({ invoice: canonicalInvoiceJson(s.invoice), link: s.link, createdAt: s.createdAt, ...(gst ? { gst } : {}) });
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

// ---- supplier logo, kept on this device only (never put in the link)

const LOGO_KEY = 'tazor.logo.v1';
export const LOGO_MAX_BYTES = 200 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
export const loadLogo = (): string | null => { try { return globalThis.localStorage?.getItem(LOGO_KEY) ?? null; } catch { return null; } };
export const saveLogo = (dataUrl: string | null): boolean => {
  try {
    if (dataUrl) globalThis.localStorage.setItem(LOGO_KEY, dataUrl); else globalThis.localStorage.removeItem(LOGO_KEY);
    return true;
  } catch { return false; }
};

// ---- supplier account follows the payee (it drives the supplier check on /pay)

type Party = { name: string; account: string };
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Applies a user edit; an untouched supplier account mirrors the payee. */
export function applyFormEdit(f: InvoiceForm, patch: Partial<InvoiceForm>, touched: ReadonlySet<keyof InvoiceForm>): InvoiceForm {
  const next = { ...f, ...patch };
  if (patch.payee !== undefined && patch.supplierAccount === undefined && !touched.has('supplierAccount')) next.supplierAccount = patch.payee;
  return next;
}

/** Fills untouched fields from the selected company (the supplier) and the other company (the customer). */
export function prefillForm(f: InvoiceForm, company: Party, customer: Party | null, touched: ReadonlySet<keyof InvoiceForm>): InvoiceForm {
  const payee = touched.has('payee') ? f.payee : company.account;
  return {
    ...f,
    supplierName: touched.has('supplierName') ? f.supplierName : company.name,
    payee,
    supplierAccount: touched.has('supplierAccount') ? f.supplierAccount : payee,
    customer: touched.has('customer') || !customer ? f.customer : customer.account,
  };
}

/** A warning when the supplier account is still the selected company's while the name and payee say otherwise. */
export function supplierAccountWarning(f: InvoiceForm, company: Party): string | null {
  return f.supplierName.trim() !== company.name && same(f.supplierAccount, company.account) && !same(f.payee, company.account)
    ? `This is ${company.name}'s account; check the supplier account matches the payee's company.`
    : null;
}

// ---- "Fill with sample data": a realistic Bluejay → Acme invoice, small enough for the demo account to pay often

const SAMPLE_LINES: [string, number, string][] = [
  ['Road freight Mumbai → Pune, 20 ft container', 0.42, '996511'],
  ['Port handling, JNPT', 0.18, '996719'],
  ['Customs documentation', 0.12, '998599'],
  ['Cargo insurance (0.3 % of value)', 0.07, '997136'],
  ['Last-mile delivery, Pune MIDC', 0.21, '996511'],
  ['Warehouse storage, 3 days', 0.15, '996729'],
];
/** Sample GSTINs (format-valid, fictitious): both in Maharashtra, so the sample shows CGST + SGST. */
export const SAMPLE_GSTIN = { bluejay: '27AABCB1234C1Z5', acme: '27AACCA5678D1Z2' };

/** A sample invoice from `supplier` to `buyer`: 2–3 freight lines totalling 0.5–1.5 USDT, GST 18 %, due in 14 days. */
export function sampleInvoice(
  supplier: { name: string; account: string }, buyer: { account: string }, now = new Date(), rand: () => number = Math.random,
): { form: InvoiceForm; taxRate: string; taxLabel: string; gst: GstMeta } {
  const pool = [...SAMPLE_LINES];
  const n = 2 + Math.floor(rand() * 2);
  const lines: LineForm[] = [];
  const hsn: string[] = [];
  for (let i = 0; i < n; i++) {
    const [description, price, sac] = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    lines.push({ description, quantity: i === 0 ? String(1 + Math.floor(rand() * 2)) : '1', unitPrice: price.toFixed(2) });
    hsn.push(sac);
  }
  // keep the subtotal inside 0.5–1.5 USDT
  while (formTotal({ lines } as InvoiceForm) < 500_000n) lines[0] = { ...lines[0], quantity: String(Number(lines[0].quantity) + 1) };
  while (formTotal({ lines } as InvoiceForm) > 1_500_000n && Number(lines[0].quantity) > 1) lines[0] = { ...lines[0], quantity: String(Number(lines[0].quantity) - 1) };
  const due = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const po = `PO-${now.getUTCFullYear()}-${String(1000 + Math.floor(rand() * 9000))}`;
  return {
    form: { customer: buyer.account, payee: supplier.account, supplierName: supplier.name, supplierAccount: supplier.account, lines, dueDate: due, memo: po },
    taxRate: '18', taxLabel: 'GST',
    gst: { supplierGstin: SAMPLE_GSTIN.bluejay, buyerGstin: SAMPLE_GSTIN.acme, placeOfSupply: '27', hsn },
  };
}

/** Unpaid invoices created on this device that can form one payment run: the buyer with the most of them, up to `max` links. */
export function runCandidates(list: StoredInvoice[], payments: PaymentRecord[], max = 50): { buyer: Address; links: string[] } | null {
  const byBuyer = new Map<string, StoredInvoice[]>();
  for (const s of list) {
    if (invoiceStatus(s.invoice, payments) === 'paid') continue;
    const k = s.invoice.buyerAccount.toLowerCase();
    byBuyer.set(k, [...(byBuyer.get(k) ?? []), s]);
  }
  const best = [...byBuyer.values()].sort((a, b) => b.length - a.length)[0];
  return best ? { buyer: best[0].invoice.buyerAccount, links: best.slice(0, max).map((s) => s.link) } : null;
}
