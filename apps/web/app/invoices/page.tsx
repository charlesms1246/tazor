'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { config } from '@/lib/config.ts';
import { invoiceHash } from '@/lib/invoice.ts';
import { encodeInvoiceLink } from '@/lib/invoice-link.ts';
import {
  buildInvoice, draftTax, formTotal, invoiceStatus, lineTotal, loadInvoices, loadLogo, LOGO_MAX_BYTES, LOGO_TYPES, newInvoiceId,
  parseRate, parseUsdt, saveInvoice, saveLogo, withTax, type InvoiceForm, type LineForm, type StoredInvoice,
} from '@/lib/invoices-store.ts';
import { loadPayments } from '@/lib/storage.ts';
import type { PaymentRecord } from '@/lib/export.ts';
import { Addr, Card, CopyButton, Empty, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { InvoicePaper, paperFromInvoice, printInvoice, type PaperInvoice } from '../_invoice/paper.tsx';

const amt = (v: bigint) => <>{formatUnits(v, 6)} <span className="faint">USDT</span></>;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const blankLine = (): LineForm => ({ description: '', quantity: '1', unitPrice: '' });

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
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setList(loadInvoices()); setPayments(loadPayments()); setLogo(loadLogo()); }, []);

  const set = (patch: Partial<InvoiceForm>) => { setForm({ ...form, ...patch }); setError(''); setDirty(true); };
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
  const shown = viewing ?? (dirty ? null : created);
  const paper = shown ? paperFromInvoice(shown.invoice, shown.createdAt) : draft;
  const shownStatus = shown ? invoiceStatus(shown.invoice, payments) : 'draft';
  const paidTx = shown && shownStatus === 'paid'
    ? payments.find((p) => { try { return invoiceHash(p.invoice) === invoiceHash(shown.invoice); } catch { return false; } })?.txHash ?? null
    : null;

  const onCreate = async () => {
    setBusy(true); setError(''); setCreated(null);
    try {
      if (taxRateError) return setError('Tax % must be a number from 0 to 100 with up to 2 decimals.');
      const r = buildInvoice(withTax(form, taxRate, taxLabel), newInvoiceId());
      if ('error' in r) return setError(r.error);
      const link = await encodeInvoiceLink(r.invoice, location.origin);
      const stored = { invoice: r.invoice, link, createdAt: Math.floor(Date.now() / 1000) };
      if (!saveInvoice(stored)) setError('Created, but this browser would not save it to the list; copy the link now.');
      setCreated(stored);
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
    <div className="page">
      <PageHeader title="Invoices" subtitle="Create a payment link; your customer approves it with a passkey and pays in USDT on Whitechain." />

      <div className="inv-split">
        <Card title="Create invoice" subtitle="The link carries the invoice encrypted; only someone with the link can read it.">
          <div className="stack">
            <div className="fields-2">
              <Field label="Customer company account" hint="The Tazor account that will pay.">
                <input data-testid="inv-customer" className="input mono" value={form.customer} onChange={(e) => set({ customer: e.target.value })} placeholder="0x…" />
              </Field>
              <Field label="Payee" hint="Where the USDT goes.">
                <input data-testid="inv-payee" className="input mono" value={form.payee} onChange={(e) => set({ payee: e.target.value })} placeholder="0x…" />
              </Field>
              <Field label="Supplier name">
                <input data-testid="inv-supplier-name" className="input" value={form.supplierName} onChange={(e) => set({ supplierName: e.target.value })} placeholder="Your company name" />
              </Field>
              <Field label="Supplier account" hint="Optional; defaults to the payee.">
                <input data-testid="inv-supplier-account" className="input mono" value={form.supplierAccount} onChange={(e) => set({ supplierAccount: e.target.value })} placeholder="0x…" />
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
                  <span className="mono break" data-testid="inv-link">{created.link}</span>
                  <span className="row">
                    <CopyButton value={created.link} label="Copy link" />
                    <a className="btn btn-sm" data-testid="inv-open" href={created.link} target="_blank" rel="noreferrer">Open</a>
                    <button type="button" className="btn btn-sm" data-testid="inv-pdf" onClick={() => { setViewing(null); setDirty(false); setPreview(true); setTimeout(printInvoice, 50); }}>Download PDF</button>
                  </span>
                </span>
              </Notice>
            )}
          </div>
        </Card>


        <div className="stack" style={{ gap: 12 }}>
          <div className="paper-toggle">
            <button type="button" data-testid="inv-preview-toggle" className="btn" aria-expanded={preview} onClick={() => setPreview(!preview)}>
              {preview ? 'Hide invoice' : 'Preview invoice'}
            </button>
          </div>
          <div className="paper-col paper-sticky" data-open={preview || viewing ? 'true' : 'false'} data-testid="inv-preview">
            {viewing && (
              <div className="spread">
                <span className="small muted">Viewing {viewing.invoice.id} (read-only)</span>
                <span className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-sm" data-testid="inv-view-pdf" onClick={printInvoice}>Download PDF</button>
                  <button type="button" className="btn btn-sm btn-ghost" data-testid="inv-view-close" onClick={() => setViewing(null)}>Back to editing</button>
                </span>
              </div>
            )}
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
          <div className="table-wrap"><table className="table table-stack">
            <thead><tr><th>Invoice</th><th className="num">Amount</th><th>Status</th><th>Link</th></tr></thead>
            <tbody>
              {list.map((s) => {
                const paid = invoiceStatus(s.invoice, payments) === 'paid';
                return (
                  <tr key={s.link} data-testid="inv-row" className="inv-row" data-selected={viewing?.link === s.link ? 'true' : undefined} onClick={() => { setViewing(s); setPreview(true); }} style={{ cursor: 'pointer' }}>
                    <td>{s.invoice.id}<span className="cell-sub">To <Addr value={s.invoice.buyerAccount} href={`${config.explorer}/address/${s.invoice.buyerAccount}`} /> · due {day(s.invoice.dueDate)}</span></td>
                    <td className="num">{amt(s.invoice.amount)}</td>
                    <td><Pill tone={paid ? 'positive' : 'info'} testId="inv-status">{paid ? 'Paid' : 'Sent'}</Pill></td>
                    <td>
                      <span className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="btn btn-sm" data-testid="inv-view" onClick={() => { setViewing(s); setPreview(true); }}>View</button>
                        <CopyButton value={s.link} label="Copy link" />
                        <a className="btn btn-sm" href={s.link} target="_blank" rel="noreferrer">Open</a>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
