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
import { InvoicePaper, paperFromInvoice, printInvoice, type PaperInvoice } from '../_invoice/paper.tsx';
import { HistoryTimeline } from '../_invoice/history.tsx';
import { useHistory, useSubjectHistory } from '@/lib/chain-history.ts';
import { COMPANIES, companyByAccount, useCompany } from '@/lib/company.ts';
import { recordEvent } from '@/lib/events.ts';
import { INVOICE_STEPS, partyName, subjectOf } from '@/lib/story.ts';
import '../_invoice/touch.css';
import { toast, Toasts } from '../_invoice/toast.tsx';

const amt = (v: bigint) => <>{formatUnits(v, 6)} <span className="faint">USDT</span></>;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const blankLine = (): LineForm => ({ description: '', quantity: '1', unitPrice: '' });

type ListTab = 'all' | 'sent' | 'paid' | 'overdue';
const LIST_TABS: { id: ListTab; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'sent', label: 'Sent' }, { id: 'paid', label: 'Paid' }, { id: 'overdue', label: 'Overdue' },
];
const STATUS_PILL = { paid: { tone: 'positive', text: 'Paid' }, sent: { tone: 'info', text: 'Sent' }, overdue: { tone: 'negative', text: 'Overdue' } } as const;

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
  const [query, setQuery] = useState('');
  const company = useCompany();
  const touched = useRef(new Set<keyof InvoiceForm>());
  const [sampleNote, setSampleNote] = useState('');

  // the demo always goes Bluejay (supplier) → Acme (buyer): acting as Acme switches the supplier to Bluejay
  const onFillSample = () => {
    const supplier = COMPANIES.find((c) => c.id === 'bluejay')!;
    const buyer = COMPANIES.find((c) => c.id === 'acme')!;
    const s = sampleInvoice(supplier, buyer);
    for (const k of Object.keys(s.form) as (keyof InvoiceForm)[]) touched.current.add(k);
    setForm(s.form);
    setTaxRate(s.taxRate);
    setTaxLabel(s.taxLabel);
    setError(''); setDirty(true);
    setSampleNote(company.id === 'bluejay'
      ? `Sample invoice from ${supplier.name} to ${buyer.name}. Create the payment link, then open it to pay as ${buyer.name}.`
      : `You're acting as ${company.name}, so the sample bills ${buyer.name} from ${supplier.name} (the supplier was switched). Create the payment link, then open it to approve as ${buyer.name}.`);
  };
  const drawerHistory = useSubjectHistory(viewing ? subjectOf(viewing.invoice) : null, viewing?.invoice.buyerAccount);
  const chain = useHistory(company.account);
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
    memo: form.memo, tax,
  };
  const shown = dirty ? null : created;
  const paper = shown ? paperFromInvoice(shown.invoice, shown.createdAt) : draft;
  // paid if this device recorded the payment, or the chain shows an InvoicePaid for this invoice hash
  const chainPaid = new Map(chain.events.filter((e) => e.kind === 'paid' && e.tx).map((e) => [e.subject.toLowerCase(), e.tx!]));
  const txOf = (s: StoredInvoice | null): string | null => {
    if (!s) return null;
    if (invoiceStatus(s.invoice, payments) === 'paid') {
      return payments.find((p) => { try { return invoiceHash(p.invoice) === invoiceHash(s.invoice); } catch { return false; } })?.txHash ?? null;
    }
    return chainPaid.get(subjectOf(s.invoice)) ?? null;
  };
  const isPaid = (s: StoredInvoice) => invoiceStatus(s.invoice, payments) === 'paid' || chainPaid.has(subjectOf(s.invoice));
  const shownStatus = shown ? (isPaid(shown) ? 'paid' : 'sent') : 'draft';
  const paidTx = txOf(shown);

  const nowSec = Math.floor(Date.now() / 1000);
  const rowStatus = (s: StoredInvoice): 'paid' | 'sent' | 'overdue' =>
    isPaid(s) ? 'paid' : s.invoice.dueDate < nowSec ? 'overdue' : 'sent';
  const inTab = (s: StoredInvoice, t: ListTab) => t === 'all' || rowStatus(s) === t;
  const q = query.trim().toLowerCase();
  const matches = (s: StoredInvoice) => !q || [
    s.invoice.id, s.invoice.buyerAccount, partyName(s.invoice.buyerAccount), formatUnits(s.invoice.amount, 6), s.invoice.memo,
  ].some((v) => v.toLowerCase().includes(q));
  const rows = list.filter((s) => inTab(s, listTab) && matches(s));
  const tabStats = (t: ListTab) => {
    const xs = list.filter((s) => inTab(s, t));
    return { count: xs.length, total: xs.reduce((a, s) => a + s.invoice.amount, 0n) };
  };
  const openDrawer = (s: StoredInvoice) => setViewing(s);

  const onCreate = async () => {
    setBusy(true); setError(''); setCreated(null);
    try {
      if (taxRateError) return setError('Tax % must be a number from 0 to 100 with up to 2 decimals.');
      const r = buildInvoice(withTax(form, taxRate, taxLabel), newInvoiceId());
      if ('error' in r) return setError(r.error);
      const link = await encodeInvoiceLink(r.invoice, location.origin);
      const stored = { invoice: r.invoice, link, createdAt: Math.floor(Date.now() / 1000) };
      if (!saveInvoice(stored)) setError('Created, but this browser would not save it to the list; copy the link now.');
      const subject = subjectOf(r.invoice);
      const to = partyName(r.invoice.buyerAccount);
      recordEvent({ subject, kind: 'created', at: stored.createdAt * 1000, title: `${r.invoice.id} created by ${r.invoice.supplierName}`, actor: r.invoice.supplierName, detail: `${formatUnits(r.invoice.amount, 6)} USDT` });
      recordEvent({ subject, kind: 'sent', at: Date.now(), title: `${r.invoice.id} sent to ${to}`, detail: 'payment link generated' });
      setCreated(stored);
      toast(`Payment link for ${r.invoice.id} created`);
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
                    <div className="spread">
                      {form.lines.length > 1
                        ? <button type="button" data-testid={`inv-remove-line-${n}`} className="btn btn-sm btn-ghost" onClick={() => set({ lines: form.lines.filter((_, i) => i !== n) })}>Remove line</button>
                        : <span />}
                      <span className="num" data-testid={`inv-line-total-${n}`}>{t === null ? <span className="faint">—</span> : amt(t)}</span>
                    </div>
                  </div>
                );
              })}
              <div className="spread">
                <button type="button" data-testid="inv-add-line" className="btn btn-sm" onClick={() => set({ lines: [...form.lines, blankLine()] })}>Add line</button>
                <span className="num" style={{ fontWeight: 500 }}>Total <span data-testid="inv-total">{amt(total)}</span></span>
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
                  <span className="mono break inv-link-text" data-testid="inv-link" title={created.link}>{created.link}</span>
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

      <Card title="Invoices on this device" flush testId="inv-list">
        {list.length === 0 ? (
          <div style={{ padding: '0 24px 24px' }}>
            <Empty><span data-testid="inv-empty">No invoices created on this device yet. Create one above to get a payment link.</span></Empty>
          </div>
        ) : (
          <>
            <div className="list-bar">
              <div className="tabs" role="tablist">
                {LIST_TABS.map((t) => {
                  const st = tabStats(t.id);
                  return (
                    <button key={t.id} role="tab" className="tab" aria-selected={listTab === t.id} data-testid={`inv-tab-${t.id}`} onClick={() => setListTab(t.id)}>
                      {t.label}<span className="tab-count" data-testid={`inv-tab-count-${t.id}`}>{st.count}</span>
                      <span className="tab-sum" data-testid={`inv-tab-total-${t.id}`}>{formatUnits(st.total, 6)} USDT</span>
                    </button>
                  );
                })}
              </div>
              <input data-testid="inv-search" className="input list-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer, number or amount" aria-label="Search invoices" />
            </div>
            {rows.length === 0 ? (
              <div style={{ padding: '16px 24px 24px' }}><Empty><span data-testid="inv-filter-empty">No invoices match{q ? ` "${query.trim()}"` : ''} in this tab.</span></Empty></div>
            ) : (
              <div className="table-wrap"><table className="table table-stack">
                <thead><tr><th>Invoice</th><th>Customer</th><th className="num">Amount</th><th>Due</th><th>Status</th><th>Link</th></tr></thead>
                <tbody>
                  {rows.map((s) => {
                    const st = STATUS_PILL[rowStatus(s)];
                    return (
                      <tr key={s.link} data-testid="inv-row" className="inv-row" data-selected={viewing?.link === s.link ? 'true' : undefined} onClick={() => openDrawer(s)}>
                        <td>{s.invoice.id}<span className="cell-sub">{s.invoice.memo || s.invoice.lines[0]?.description}</span></td>
                        <td>{partyName(s.invoice.buyerAccount)}<span className="cell-sub mono">{s.invoice.buyerAccount.slice(0, 6)}…{s.invoice.buyerAccount.slice(-4)}</span></td>
                        <td className="num">{amt(s.invoice.amount)}</td>
                        <td className="num">{day(s.invoice.dueDate)}</td>
                        <td><Pill tone={st.tone} testId="inv-status">{st.text}</Pill></td>
                        <td>
                          <span className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="btn btn-sm" data-testid="inv-view" onClick={() => openDrawer(s)}>View</button>
                            <span onClickCapture={() => toast('Link copied')}><CopyButton value={s.link} label="Copy link" /></span>
                            <a className="btn btn-sm" href={s.link} target="_blank" rel="noreferrer">Open</a>
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
                <InvoicePaper invoice={paperFromInvoice(viewing.invoice, viewing.createdAt)} status={isPaid(viewing) ? 'paid' : 'sent'} link={viewing.link} txHash={txOf(viewing)} logo={logo} />
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
