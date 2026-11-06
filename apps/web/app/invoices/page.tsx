'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { config } from '@/lib/config.ts';
import { encodeInvoiceLink } from '@/lib/invoice-link.ts';
import {
  buildInvoice, formTotal, invoiceStatus, lineTotal, loadInvoices, newInvoiceId, saveInvoice,
  type InvoiceForm, type LineForm, type StoredInvoice,
} from '@/lib/invoices-store.ts';
import { loadPayments } from '@/lib/storage.ts';
import type { PaymentRecord } from '@/lib/export.ts';
import { Addr, Card, CopyButton, Empty, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';

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

  useEffect(() => { setList(loadInvoices()); setPayments(loadPayments()); }, []);

  const set = (patch: Partial<InvoiceForm>) => { setForm({ ...form, ...patch }); setError(''); };
  const setLine = (n: number, patch: Partial<LineForm>) => set({ lines: form.lines.map((l, i) => (i === n ? { ...l, ...patch } : l)) });
  const total = formTotal(form);

  const onCreate = async () => {
    setBusy(true); setError(''); setCreated(null);
    try {
      const r = buildInvoice(form, newInvoiceId());
      if ('error' in r) return setError(r.error);
      const link = await encodeInvoiceLink(r.invoice, location.origin);
      const stored = { invoice: r.invoice, link, createdAt: Math.floor(Date.now() / 1000) };
      if (!saveInvoice(stored)) setError('Created, but this browser would not save it to the list; copy the link now.');
      setCreated(stored);
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

      <div className="grid-2">
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
                  </span>
                </span>
              </Notice>
            )}
          </div>
        </Card>

        <Card title="Preview" subtitle="What your customer sees after opening the link." testId="inv-preview">
          <div className="stack">
            <div className="spread">
              <span style={{ fontWeight: 500 }}>{form.supplierName.trim() || <span className="faint">Supplier name</span>}</span>
              <span className="num" style={{ fontWeight: 500 }}>{amt(total)}</span>
            </div>
            <dl className="kv">
              <dt>Invoice</dt><dd>{created ? created.invoice.id : <span className="faint">Assigned when you create the link</span>}</dd>
              <dt>Pay to</dt><dd>{form.payee.trim() ? <span className="mono break">{form.payee.trim()}</span> : <span className="faint">Payee</span>}</dd>
              <dt>Buyer account</dt><dd>{form.customer.trim() ? <span className="mono break">{form.customer.trim()}</span> : <span className="faint">Customer company account</span>}</dd>
              <dt>Due</dt><dd className="num">{form.dueDate || <span className="faint">Due date</span>}</dd>
              <dt>Memo</dt><dd>{form.memo.trim() || <span className="faint">None</span>}</dd>
            </dl>
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Total</th></tr></thead>
              <tbody>
                {form.lines.map((l, n) => {
                  const t = lineTotal(l);
                  return (
                    <tr key={n}>
                      <td>{l.description.trim() || <span className="faint">Line {n + 1}</span>}</td>
                      <td className="num">{l.quantity}</td>
                      <td className="num">{t === null ? <span className="faint">—</span> : amt(t)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <p className="small muted">The customer approves with Face ID; the supplier is shown as verified only if its admin holds a WB Soul (simulated on testnet).</p>
          </div>
        </Card>
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
                  <tr key={s.link} data-testid="inv-row">
                    <td>{s.invoice.id}<span className="cell-sub">To <Addr value={s.invoice.buyerAccount} href={`${config.explorer}/address/${s.invoice.buyerAccount}`} /> · due {day(s.invoice.dueDate)}</span></td>
                    <td className="num">{amt(s.invoice.amount)}</td>
                    <td><Pill tone={paid ? 'positive' : 'info'} testId="inv-status">{paid ? 'Paid' : 'Sent'}</Pill></td>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
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
