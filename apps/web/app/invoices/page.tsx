'use client';

import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { config } from '@/lib/config.ts';
import { invoiceHash } from '@/lib/invoice.ts';
import { encodeInvoiceLink } from '@/lib/invoice-link.ts';
import {
  buildInvoice, draftTax, formTotal, invoiceStatus, lineTotal, loadInvoices, loadLogo, LOGO_MAX_BYTES, LOGO_TYPES, newInvoiceId,
  applyFormEdit, parseRate, parseUsdt, prefillForm, sampleInvoice, saveInvoice, saveLogo, supplierAccountWarning, withTax, type InvoiceForm, type LineForm, type StoredInvoice,
} from '@/lib/invoices-store.ts';
import { loadPayments } from '@/lib/storage.ts';
import type { PaymentRecord } from '@/lib/export.ts';
import { Addr, Card, CopyButton, Empty, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { ClearSampleInvoices, SampleInvoices } from '../_demo/demo-banner.tsx';
import { ReminderButton } from '../_invoice/reminder.tsx';
import { dueIn } from '@/lib/reminders.ts';
import { InvoicePaper, paperFromInvoice, printInvoice, type PaperInvoice } from '../_invoice/paper.tsx';
import { HistoryTimeline } from '../_invoice/history.tsx';
import { useHistory, useSubjectHistory } from '@/lib/chain-history.ts';
import { COMPANIES, companyByAccount, useCompany } from '@/lib/company.ts';
import { recordEvent } from '@/lib/events.ts';
import { INVOICE_STEPS, partyName, subjectOf } from '@/lib/story.ts';
import '../_invoice/touch.css';
import { toast, Toasts } from '../_invoice/toast.tsx';
import { usdtNumber } from '@/lib/money.ts';
import { cleanGst, gstProblem, STATES, type GstMeta } from '@/lib/gst.ts';
import { chainPaidMap, companyLedger, type LedgerRow, type Side } from '@/lib/ledger.ts';
import { INBOX_CHANGED, loadInbox, type InboxItem } from '@/lib/inbox.ts';
import { isCompanyAccount, setCompany } from '@/lib/company.ts';
import { Inr } from '../_invoice/inr.tsx';

const amt = (v: bigint) => <>{usdtNumber(v)} <span className="faint">USDT</span></>;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const blankLine = (): LineForm => ({ description: '', quantity: '1', unitPrice: '' });

type ListTab = 'all' | 'sent' | 'paid' | 'overdue';
const LIST_TABS: { id: ListTab; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'sent', label: 'Sent' }, { id: 'paid', label: 'Paid' }, { id: 'overdue', label: 'Overdue' },
];
const STATUS_PILL = { paid: { tone: 'positive', text: 'Paid' }, sent: { tone: 'info', text: 'Sent' }, overdue: { tone: 'negative', text: 'Overdue' } } as const;
const BILL_PILL = { ...STATUS_PILL, sent: { tone: 'info', text: 'To pay' } } as const;
const SIDES: { id: Side; label: string }[] = [{ id: 'sent', label: 'Invoices sent' }, { id: 'bills', label: 'Bills to pay' }];

export default function InvoicesPage() {
  const [form, setForm] = useState<InvoiceForm>({
    customer: '', payee: '', supplierName: '', supplierAccount: '', lines: [blankLine()], dueDate: inDays(14), memo: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<StoredInvoice | null>(null);
  const [list, setList] = useState<StoredInvoice[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [taxRate, setTaxRate] = useState('');
  const [taxLabel, setTaxLabel] = useState('GST');
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState('');
  const [viewing, setViewing] = useState<StoredInvoice | null>(null);
  const [listTab, setListTab] = useState<ListTab>('all');
  // deep link from Home (/invoices/?tab=overdue): applied once, when the company is known
  const urlTab = useRef<ListTab | null | undefined>(undefined);
  if (urlTab.current === undefined && typeof location !== 'undefined') {
    const t = new URLSearchParams(location.search).get('tab');
    urlTab.current = t === 'all' || t === 'sent' || t === 'paid' || t === 'overdue' ? t : null;
  }
  const [side, setSide] = useState<Side>('sent');
  const [gst, setGst] = useState<GstMeta>({});
  const setGstField = (patch: Partial<GstMeta>) => { setGst({ ...gst, ...patch }); setError(''); setDirty(true); };
  const setHsn = (n: number, v: string) => { const h = [...(gst.hsn ?? [])]; h[n] = v; setGstField({ hsn: h }); };
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [query, setQuery] = useState('');
  const company = useCompany();
  const touched = useRef(new Set<keyof InvoiceForm>());
  const [sampleNote, setSampleNote] = useState('');

  // the sample goes supplier → buyer, by each company's ENS `tazor.role` (else this company and another)
  const onFillSample = () => {
    const supplier = COMPANIES.find((c) => c.role === 'Supplier') ?? company;
    const buyer = COMPANIES.find((c) => c.role === 'Buyer' && c.id !== supplier.id) ?? COMPANIES.find((c) => c.id !== supplier.id);
    if (!buyer || supplier.status !== 'ready') { setSampleNote('Waiting for the companies from ENS…'); return; }
    const s = sampleInvoice(supplier, buyer);
    for (const k of Object.keys(s.form) as (keyof InvoiceForm)[]) touched.current.add(k);
    setForm(s.form);
    setTaxRate(s.taxRate);
    setTaxLabel(s.taxLabel);
    setGst(s.gst);
    setError(''); setDirty(true);
    // never let the selected company bill itself: as the buyer, switch to the supplier (visibly)
    if (company.id !== supplier.id) setCompany(supplier.id);
    setSide('sent');
    setSampleNote(company.id === supplier.id
      ? `Sample invoice from ${supplier.name} to ${buyer.name}. Create the payment link, then open it to pay as ${buyer.name}.`
      : `Switched to ${supplier.name}, the supplier, to send this invoice to ${buyer.name}. Create the payment link, then switch back to ${buyer.name} (top left) and pay it under Bills to pay.`);
  };
  const drawerHistory = useSubjectHistory(viewing ? subjectOf(viewing.invoice) : null, viewing?.invoice.buyerAccount);
  const chain = useHistory(company.account);
  // default side from the company's role once ENS has it (a placeholder company has no role yet); a tab the user picked
  // for this company is kept until they switch company
  const pickedFor = useRef<string | null>(null);
  useEffect(() => {
    if (company.status && company.status !== 'ready') return;
    if (pickedFor.current === company.id) return;
    pickedFor.current = null;
    setSide(/supplier/i.test(company.role.trim()) ? 'sent' : 'bills');
    setListTab(urlTab.current ?? 'all');
    urlTab.current = null;
  }, [company.id, company.role, company.status]);
  useEffect(() => {
    const sync = () => setInbox(loadInbox());
    sync();
    addEventListener(INBOX_CHANGED, sync);
    return () => removeEventListener(INBOX_CHANGED, sync);
  }, []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setList(loadInvoices()); setPayments(loadPayments()); setLogo(loadLogo()); }, []);

  // the selected company is the supplier; its fields (and the other company as the customer) fill in until edited
  useEffect(() => {
    setForm((f) => prefillForm(f, company, COMPANIES.find((c) => c.id !== company.id) ?? null, touched.current));
  }, [company]);

  useEffect(() => {
    if (!viewing) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewing(null); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [viewing]);

  const set = (patch: Partial<InvoiceForm>) => {
    const next = applyFormEdit(form, patch, touched.current);
    for (const k of Object.keys(patch) as (keyof InvoiceForm)[]) touched.current.add(k);
    setForm(next); setError(''); setDirty(true);
  };
  const supplierWarning = supplierAccountWarning(form, company);
  // anyone but the invoice's supplier (normally the selected company; Bluejay after "Fill with sample data" as Acme)
  const supplierCo = companyByAccount(form.supplierAccount.trim() || form.payee.trim()) ?? company;
  const billToOptions = COMPANIES.filter((c) => c.id !== supplierCo.id);
  const billTo = billToOptions.find((c) => c.account.toLowerCase() === form.customer.trim().toLowerCase())?.account ?? '';
  const setLine = (n: number, patch: Partial<LineForm>) => set({ lines: form.lines.map((l, i) => (i === n ? { ...l, ...patch } : l)) });
  const tax = draftTax(form, taxRate, taxLabel);
  const total = formTotal(form) + (tax?.amount ?? 0n);
  const taxRateError = taxRate.trim() !== '' && parseRate(taxRate) === null;

  const onLogo = (file: File | undefined) => {
    setLogoError('');
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return setLogoError('Use a PNG, JPG or SVG image.');
    if (file.size > LOGO_MAX_BYTES) return setLogoError('The logo must be 200 KB or smaller.');
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      if (!saveLogo(url)) setLogoError('This browser would not store the logo; it shows until you reload.');
      setLogo(url);
    };
    r.onerror = () => setLogoError('Could not read that file.');
    r.readAsDataURL(file);
  };
  const onRemoveLogo = () => { saveLogo(null); setLogo(null); setLogoError(''); };

  const draft: PaperInvoice = {
    id: null, supplierName: form.supplierName, payee: form.payee, buyer: form.customer, issued: null,
    due: form.dueDate ? Math.floor(new Date(`${form.dueDate}T00:00:00Z`).getTime() / 1000) || null : null,
    lines: form.lines.map((l) => ({
      description: l.description,
      quantity: /^[1-9]\d*$/.test(l.quantity.trim()) ? BigInt(l.quantity.trim()) : null,
      unitPrice: parseUsdt(l.unitPrice),
    })),
    memo: form.memo, tax, gst: cleanGst(gst),
  };
  const shown = dirty ? null : created;
  const paper = shown ? paperFromInvoice(shown.invoice, shown.createdAt, shown.gst) : draft;
  // one source for statuses and totals (lib/ledger.ts): device invoices + payments + inbox + chain, per company
  const ledger = companyLedger({ company, invoices: list, payments, inbox, chainPaid: chainPaidMap(chain.events) });
  const byKey = new Map([...ledger.sent, ...ledger.bills].map((r) => [r.key, r]));
  const rowOf = (s: StoredInvoice | null) => (s ? byKey.get(subjectOf(s.invoice)) ?? null : null);
  const fallbackPaid = (s: StoredInvoice) => invoiceStatus(s.invoice, payments) === 'paid' || chainPaidMap(chain.events).has(subjectOf(s.invoice));
  const isPaid = (s: StoredInvoice) => (rowOf(s)?.status ?? (fallbackPaid(s) ? 'paid' : 'sent')) === 'paid';
  const txOf = (s: StoredInvoice | null): string | null => (s ? rowOf(s)?.paidTx ?? null : null);
  const shownStatus = shown ? (isPaid(shown) ? 'paid' : 'sent') : 'draft';
  const paidTx = txOf(shown);

  const nowSec = Math.floor(Date.now() / 1000);
  const rowStatus = (s: StoredInvoice): 'paid' | 'sent' | 'overdue' =>
    rowOf(s)?.status ?? (isPaid(s) ? 'paid' : s.invoice.dueDate < nowSec ? 'overdue' : 'sent');
  const sideRows = ledger[side];
  const inTab = (r: LedgerRow, t: ListTab) => t === 'all' || r.status === t;
  const q = query.trim().toLowerCase();
  const who = (r: LedgerRow) => r.counterpartyName ?? (r.counterparty ? partyName(r.counterparty) : '');
  const matches = (r: LedgerRow) => !q || [
    r.id, r.counterparty ?? '', who(r), formatUnits(r.amount, 6), usdtNumber(r.amount), r.stored?.invoice.memo ?? '',
  ].some((v) => v.toLowerCase().includes(q));
  const rows = sideRows.filter((r) => inTab(r, listTab) && matches(r));
  const tabStats = (t: ListTab) => {
    const xs = sideRows.filter((r) => inTab(r, t));
    return { count: xs.length, total: xs.reduce((a, r) => a + r.amount, 0n) };
  };
  const openDrawer = (s: StoredInvoice) => setViewing(s);
  const pill = (r: LedgerRow) => (r.side === 'bills' ? BILL_PILL : STATUS_PILL)[r.status];
  const otherCompany = COMPANIES.find((c) => c.id !== company.id);

  const onCreate = async () => {
    setBusy(true); setError(''); setCreated(null);
    try {
      if (taxRateError) return setError('Tax % must be a number from 0 to 100 with up to 2 decimals.');
      const gstErr = gstProblem(gst);
      if (gstErr) return setError(gstErr);
      const meta = cleanGst({ ...gst, hsn: gst.hsn?.slice(0, form.lines.length) });
      const r = buildInvoice(withTax(form, taxRate, taxLabel), newInvoiceId());
      if ('error' in r) return setError(r.error);
      const link = await encodeInvoiceLink(r.invoice, location.origin, meta);
      const stored = { invoice: r.invoice, link, createdAt: Math.floor(Date.now() / 1000), gst: meta };
      if (!saveInvoice(stored)) setError('Created, but this browser would not save it to the list; copy the link now.');
      const subject = subjectOf(r.invoice);
      const to = partyName(r.invoice.buyerAccount);
      recordEvent({ subject, kind: 'created', at: stored.createdAt * 1000, title: `${r.invoice.id} created by ${r.invoice.supplierName}`, actor: r.invoice.supplierName, detail: `${usdtNumber(r.invoice.amount)} USDT` });
      recordEvent({ subject, kind: 'sent', at: Date.now(), title: `${r.invoice.id} sent to ${to}`, detail: 'payment link generated' });
      setCreated(stored);
      toast(`Payment link for ${r.invoice.id} created`);
      if (isCompanyAccount(company, r.invoice.buyerAccount) && !isCompanyAccount(company, r.invoice.payee) && !isCompanyAccount(company, r.invoice.supplierAccount)) setSide('bills');
      else setSide('sent');
      setViewing(null);
      setDirty(false);
      setList(loadInvoices());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page tz-touch">
      <Toasts />
      <PageHeader title="Invoices" subtitle="Create a payment link; your customer approves it with a passkey and pays in USDT on Whitechain." />

      <div className="inv-split">
        <div data-tour="invoice-form">
        <Card title="Create invoice" subtitle={<>You are invoicing as <b>{company.name}</b>. The link carries the invoice encrypted; only someone with the link can read it.</>}>
          <div className="stack">
            <div className="sample-bar">
              <button type="button" className="btn btn-sm" data-testid="inv-fill-sample" onClick={onFillSample}>Fill with sample data</button>
              {sampleNote && <span className="small muted" data-testid="inv-sample-hint">{sampleNote}</span>}
            </div>
            <Field label="Bill to">
              <select data-testid="inv-billto" className="select" value={billTo} onChange={(e) => set({ customer: e.target.value })}>
                {billToOptions.map((c) => <option key={c.id} value={c.account}>{c.name} ({c.ens})</option>)}
                <option value="">Other address</option>
              </select>
            </Field>
            <div className="fields-2">
              <Field label="Customer company account" hint={companyByAccount(form.customer) ? `The Tazor account that will pay (${companyByAccount(form.customer)!.name}).` : 'The Tazor account that will pay.'}>
                <input data-testid="inv-customer" className="input mono" value={form.customer} onChange={(e) => set({ customer: e.target.value })} placeholder="0x…" />
              </Field>
              <Field label="Payee" hint="Where the USDT goes.">
                <input data-testid="inv-payee" className="input mono" value={form.payee} onChange={(e) => set({ payee: e.target.value })} placeholder="0x…" />
              </Field>
              <Field label="Supplier name">
                <input data-testid="inv-supplier-name" className="input" value={form.supplierName} onChange={(e) => set({ supplierName: e.target.value })} placeholder="Your company name" />
              </Field>
              <Field label="Supplier account" hint="Follows the payee until you edit it.">
                <input data-testid="inv-supplier-account" className="input mono" value={form.supplierAccount} onChange={(e) => set({ supplierAccount: e.target.value })} placeholder="0x…" />
                {supplierWarning && <span className="small" data-testid="inv-supplier-warning" style={{ color: 'var(--pill-warning-ink)' }}>{supplierWarning}</span>}
              </Field>
            </div>

            <div className="stack" style={{ gap: 12 }}>
              <span className="field-label">Line items</span>
              {form.lines.map((l, n) => {
                const t = lineTotal(l);
                return (
                  <div key={n} className="well stack" style={{ gap: 12 }}>
                    <Field label={`Description, line ${n + 1}`}>
                      <input data-testid={`inv-line-desc-${n}`} className="input" value={l.description} onChange={(e) => setLine(n, { description: e.target.value })} />
                    </Field>
                    <div className="fields-2">
                      <Field label="Quantity">
                        <input data-testid={`inv-line-qty-${n}`} className="input num" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(n, { quantity: e.target.value })} />
                      </Field>
                      <Field label="Unit price">
                        <span className="input-affix">
                          <input data-testid={`inv-line-price-${n}`} className="input num" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(n, { unitPrice: e.target.value })} placeholder="0.00" style={{ textAlign: 'right' }} />
                          <span>USDT</span>
                        </span>
                      </Field>
                    </div>
                    <Field label="HSN/SAC (optional)">
                      <input data-testid={`inv-line-hsn-${n}`} className="input mono" inputMode="numeric" value={gst.hsn?.[n] ?? ''} onChange={(e) => setHsn(n, e.target.value.trim())} placeholder="e.g. 996511" />
                    </Field>
                    <div className="spread">
                      {form.lines.length > 1
                        ? <button type="button" data-testid={`inv-remove-line-${n}`} className="btn btn-sm btn-ghost" onClick={() => { set({ lines: form.lines.filter((_, i) => i !== n) }); if (gst.hsn) setGst({ ...gst, hsn: gst.hsn.filter((_, i) => i !== n) }); }}>Remove line</button>
                        : <span />}
                      <span className="num" data-testid={`inv-line-total-${n}`}>{t === null ? <span className="faint">—</span> : amt(t)}</span>
                    </div>
                  </div>
                );
              })}
              <div className="spread">
                <button type="button" data-testid="inv-add-line" className="btn btn-sm" onClick={() => set({ lines: [...form.lines, blankLine()] })}>Add line</button>
                <span className="num" style={{ fontWeight: 500 }}>Total <span data-testid="inv-total">{amt(total)}</span><Inr v={total} testId="inv-total-inr" /></span>
              </div>
            </div>

            <div className="fields-2">
              <Field label="Due date">
                <input data-testid="inv-due" type="date" className="input" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
              </Field>
              <Field label="Memo" hint="Shown to the customer, e.g. a PO number.">
                <input data-testid="inv-memo" className="input" value={form.memo} onChange={(e) => set({ memo: e.target.value })} />
              </Field>
            </div>

            <div className="fields-2">
              <Field label="Tax %" hint="Optional; added as a final line.">
                <span className="input-affix">
                  <input data-testid="inv-tax-rate" className="input num" inputMode="decimal" value={taxRate} onChange={(e) => { setTaxRate(e.target.value); setError(''); setDirty(true); }} placeholder="0" style={{ textAlign: 'right' }} />
                  <span>%</span>
                </span>
              </Field>
              <Field label="Tax label">
                <input data-testid="inv-tax-label" className="input" value={taxLabel} onChange={(e) => { setTaxLabel(e.target.value); setDirty(true); }} />
              </Field>
            </div>
            {taxRateError && <Notice tone="negative" testId="inv-tax-error">Tax % must be a number from 0 to 100 with up to 2 decimals.</Notice>}

            <details className="tech-details" data-testid="inv-gst" open={!!cleanGst(gst) || undefined}>
              <summary>GST details (optional)</summary>
              <div className="stack" style={{ gap: 12 }}>
                <div className="fields-2">
                  <Field label="Supplier GSTIN">
                    <input data-testid="inv-gstin-supplier" className="input mono" value={gst.supplierGstin ?? ''} onChange={(e) => setGstField({ supplierGstin: e.target.value.toUpperCase() })} placeholder="27AABCB1234C1Z5" maxLength={15} />
                  </Field>
                  <Field label="Buyer GSTIN">
                    <input data-testid="inv-gstin-buyer" className="input mono" value={gst.buyerGstin ?? ''} onChange={(e) => setGstField({ buyerGstin: e.target.value.toUpperCase() })} placeholder="27AACCA5678D1Z2" maxLength={15} />
                  </Field>
                </div>
                <Field label="Place of supply" hint="Same state as the supplier: CGST + SGST; another state: IGST. Shown on the invoice; the tax total is unchanged.">
                  <select data-testid="inv-pos" className="select" value={gst.placeOfSupply ?? ''} onChange={(e) => setGstField({ placeOfSupply: e.target.value || undefined })}>
                    <option value="">Not set</option>
                    {STATES.map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
                  </select>
                </Field>
                <p className="small muted" style={{ margin: 0 }}>GST details travel encrypted with the link and print on the invoice. They are not part of what approvers sign.</p>
              </div>
            </details>

            <Field label="Logo" hint="PNG, JPG or SVG, up to 200 KB. Your logo shows on your copy and PDF; the customer's link shows your name.">
              <span className="row" style={{ gap: 8 }}>
                <input data-testid="inv-logo" type="file" accept="image/png,image/jpeg,image/svg+xml" className="input" onChange={(e) => { onLogo(e.target.files?.[0]); e.target.value = ''; }} />
                {logo && <button type="button" data-testid="inv-logo-remove" className="btn btn-sm btn-ghost" onClick={onRemoveLogo}>Remove logo</button>}
              </span>
            </Field>
            {logoError && <Notice tone="negative" testId="inv-logo-error">{logoError}</Notice>}

            {error && <Notice tone="negative" testId="inv-error">{error}</Notice>}
            <div className="row">
              <button data-testid="inv-create" className="btn btn-primary" onClick={onCreate} disabled={busy}>Create payment link</button>
            </div>
            {created && (
              <Notice tone="positive">
                <span className="stack" style={{ gap: 8 }}>
                  <span>Invoice {created.invoice.id} is ready. Send this link to your customer:</span>
                  <span className="small muted" data-testid="inv-link" data-link={created.link}>Encrypted payment link for {created.invoice.id}: only someone with the link can read the invoice.</span>
                  <span className="row">
                    <span onClickCapture={() => toast('Link copied')}><CopyButton value={created.link} label="Copy link" /></span>
                    <a className="btn btn-sm" data-testid="inv-open" href={created.link} target="_blank" rel="noreferrer">Open</a>
                    <button type="button" className="btn btn-sm" data-testid="inv-pdf" onClick={() => { setViewing(null); setDirty(false); setPreview(true); setTimeout(printInvoice, 50); }}>Download PDF</button>
                  </span>
                </span>
              </Notice>
            )}
          </div>
        </Card>
        </div>

        <div className="stack" style={{ gap: 12 }}>
          <div className="paper-toggle">
            <button type="button" data-testid="inv-preview-toggle" className="btn" aria-expanded={preview} onClick={() => setPreview(!preview)}>
              {preview ? 'Hide invoice' : 'Preview invoice'}
            </button>
          </div>
          <div className={viewing ? 'paper-col paper-sticky no-print' : 'paper-col paper-sticky'} data-open={preview ? 'true' : 'false'} data-testid="inv-preview" data-tour="invoice-paper">
            <InvoicePaper invoice={paper} status={shownStatus} link={shown?.link ?? null} txHash={paidTx} logo={logo} />
          </div>
        </div>
      </div>

      <Card title={company.name} subtitle="Invoices on this device and on Whitechain, from this company's side." flush testId="inv-list">
        <div className="tabs side-tabs" role="tablist" aria-label="Perspective">
          {SIDES.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={side === t.id} data-testid={`inv-side-${t.id}`} onClick={() => { pickedFor.current = company.id; setSide(t.id); setListTab('all'); }}>
              {t.label}<span className="tab-count">{ledger[t.id].length}</span>
            </button>
          ))}
        </div>
        {sideRows.length === 0 ? (
          <div style={{ padding: '16px 24px 24px' }}>
            {side === 'sent' ? (
              <Empty>
                <span data-testid="inv-empty">
                  {/supplier/i.test(company.role) || list.length === 0
                    ? `No invoices sent by ${company.name} yet. Create one above to get a payment link.`
                    : `${company.name} is the buyer in this demo, so it has no invoices to send.`}
                </span>
                {!/supplier/i.test(company.role) && otherCompany && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button type="button" className="btn btn-sm" data-testid="inv-switch-supplier" onClick={() => setCompany(otherCompany.id)}>Switch to {otherCompany.name} to send an invoice</button>
                  </div>
                )}
                <SampleInvoices />
              </Empty>
            ) : (
              <Empty><span data-testid="inv-bills-empty">No bills for {company.name} yet. When a supplier sends a payment link and it is opened here, it appears in this list.</span><SampleInvoices /></Empty>
            )}
          </div>
        ) : (
          <>
            <div className="list-bar">
              <div className="tabs" role="tablist">
                {LIST_TABS.map((t) => {
                  const st = tabStats(t.id);
                  return (
                    <button key={t.id} role="tab" className="tab" aria-selected={listTab === t.id} data-testid={`inv-tab-${t.id}`} onClick={() => setListTab(t.id)}>
                      {side === 'bills' && t.id === 'sent' ? 'To pay' : t.label}<span className="tab-count" data-testid={`inv-tab-count-${t.id}`}>{st.count}</span>
                      <span className="tab-sum" data-testid={`inv-tab-total-${t.id}`}>{usdtNumber(st.total)} USDT</span>
                    </button>
                  );
                })}
              </div>
              <input data-testid="inv-search" className="input list-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={side === 'sent' ? 'Search customer, number or amount' : 'Search supplier, number or amount'} aria-label="Search invoices" />
            </div>
            {rows.length === 0 ? (
              <div style={{ padding: '16px 24px 24px' }}><Empty><span data-testid="inv-filter-empty">No invoices match{q ? ` "${query.trim()}"` : ''} in this tab.</span></Empty></div>
            ) : (
              <div className="table-wrap"><table className="table table-stack">
                <thead><tr><th>Invoice</th><th>{side === 'sent' ? 'Customer' : 'Supplier'}</th><th className="num">Amount</th><th>Due</th><th>Status</th><th>{side === 'sent' ? 'Link' : ''}</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const st = pill(r);
                    const s = r.stored;
                    return (
                      <tr key={r.key} data-testid="inv-row" data-side={r.side} className="inv-row" data-selected={viewing && s && viewing.link === s.link ? 'true' : undefined}
                        onClick={() => (s ? openDrawer(s) : r.link && location.assign(r.link))}>
                        <td>{r.id}<span className="cell-sub">{s?.invoice.memo || s?.invoice.lines[0]?.description || (r.side === 'bills' ? 'Opened from a payment link' : '')}</span></td>
                        <td>{who(r) || <span className="faint">—</span>}{r.counterparty && <span className="cell-sub mono">{r.counterparty.slice(0, 6)}…{r.counterparty.slice(-4)}</span>}</td>
                        <td className="num">{amt(r.amount)}<span className="cell-sub"><Inr v={r.amount} /></span></td>
                        <td className="num">{r.dueDate ? day(r.dueDate) : <span className="faint">—</span>}
                          {r.dueDate > 0 && r.status !== 'paid' && (() => { const d = dueIn(r.dueDate * 1000); return <span className={`cell-sub due-${d.tone}`} data-testid="inv-due-label">{d.text}</span>; })()}</td>
                        <td><Pill tone={st.tone} testId="inv-status">{st.text}</Pill></td>
                        <td>
                          <span className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                            {r.side === 'bills' && r.status !== 'paid' && r.link && <a className="btn btn-sm" data-testid="inv-pay" href={r.link}>Pay</a>}
                            {s && <button type="button" className="btn btn-sm" data-testid="inv-view" onClick={() => openDrawer(s)}>View</button>}
                            {r.side === 'sent' && s && <>
                              <span onClickCapture={() => toast('Link copied')}><CopyButton value={s.link} label="Copy link" /></span>
                              <a className="btn btn-sm" href={s.link} target="_blank" rel="noreferrer">Open</a>
                              {r.status !== 'paid' && <ReminderButton remindKey={r.key} to={who(r) || null} from={s.invoice.supplierName || company.name} what={`invoice ${r.id}`}
                                amount={usdtNumber(r.amount)} dueMs={r.dueDate ? r.dueDate * 1000 : null} link={s.link} />}
                            </>}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </>
        )}
        <ClearSampleInvoices />
      </Card>

      {viewing && (
        <>
          <div className="drawer-overlay" data-testid="inv-drawer-overlay" onClick={() => setViewing(null)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Invoice ${viewing.invoice.id}`} data-testid="inv-drawer">
            <div className="drawer-head">
              <span className="row" style={{ gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{viewing.invoice.id}</span>
                <Pill tone={STATUS_PILL[rowStatus(viewing)].tone}>{STATUS_PILL[rowStatus(viewing)].text}</Pill>
              </span>
              <button ref={closeRef} type="button" className="btn btn-sm btn-ghost" data-testid="inv-view-close" onClick={() => setViewing(null)}>Close</button>
            </div>
            <div className="drawer-body">
              <div className="row" style={{ gap: 8 }}>
                <span onClickCapture={() => toast('Link copied')}><CopyButton value={viewing.link} label="Copy link" /></span>
                <a className="btn btn-sm" data-testid="inv-drawer-open" href={viewing.link} target="_blank" rel="noreferrer">Open</a>
                <button type="button" className="btn btn-sm" data-testid="inv-view-pdf" onClick={printInvoice}>Download PDF</button>
              </div>
              <div className="paper-mini">
                <InvoicePaper invoice={paperFromInvoice(viewing.invoice, viewing.createdAt, viewing.gst)} status={isPaid(viewing) ? 'paid' : 'sent'} link={viewing.link} txHash={txOf(viewing)} logo={logo} />
              </div>
              <div>
                <h3 className="drawer-h">Activity</h3>
                <HistoryTimeline events={drawerHistory.events} loading={drawerHistory.loading} error={drawerHistory.error} steps={INVOICE_STEPS} testId="inv-timeline" />
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
