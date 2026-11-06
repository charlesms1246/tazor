'use client';

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { formatUnits, isAddress, type Address } from 'viem';
import { nameOf } from '@/lib/activity.ts';
import { config } from '@/lib/config.ts';
import type { Invoice } from '@/lib/invoice.ts';
import { splitTax, type TaxInfo } from '@/lib/invoices-store.ts';
import './paper.css';
import { toast } from './toast.tsx';

export type PaperLine = { description: string; quantity: bigint | null; unitPrice: bigint | null };
export type PaperInvoice = {
  id: string | null;
  supplierName: string;
  payee: string;
  buyer: string;
  issued: number | null;
  due: number | null;
  lines: PaperLine[];
  memo: string;
  tax: TaxInfo | null;
};
export type PaperStatus = 'draft' | 'sent' | 'paid';

/** Issue date from an id like INV-20261106-ABCD (UTC midnight), else null. */
export const issuedFromId = (id: string): number | null => {
  const m = /^INV-(\d{4})(\d{2})(\d{2})-/.exec(id);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Paper view of a created invoice; a final tax line written by withTax is shown as Tax again. */
export function paperFromInvoice(i: Invoice, issued?: number): PaperInvoice {
  const { lines, tax } = splitTax(i.lines);
  return {
    id: i.id, supplierName: i.supplierName, payee: i.payee, buyer: i.buyerAccount,
    issued: issued ?? issuedFromId(i.id), due: i.dueDate, lines, memo: i.memo, tax,
  };
}

const money = (v: bigint) => {
  const [w, f = ''] = formatUnits(v, 6).split('.');
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0')}`;
};
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || 'T';

function Party({ label, value }: { label: string; value: string }) {
  const v = value.trim();
  const name = isAddress(v) ? nameOf(v as Address) : null;
  return (
    <div className="ip-party">
      <div className="ip-label">{label}</div>
      {v ? <>
        {name && <div className="ip-party-name">{name}</div>}
        <div className="ip-mono" title={v}>{short(v)}</div>
      </> : <div className="ip-faint">Not set</div>}
    </div>
  );
}

function Qr({ link }: { link: string }) {
  const path = useMemo(() => {
    try {
      const q = qrcode(0, 'L');
      q.addData(link);
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d };
    } catch {
      return null;
    }
  }, [link]);
  if (!path) return <div className="ip-qr-box ip-faint">Link too long for a QR code</div>;
  return (
    <svg data-testid="paper-qr" className="ip-qr" viewBox={`-2 -2 ${path.n + 4} ${path.n + 4}`} role="img" aria-label="QR code for the payment link" shapeRendering="crispEdges">
      <rect x={-2} y={-2} width={path.n + 4} height={path.n + 4} className="ip-qr-bg" />
      <path d={path.d} className="ip-qr-fg" />
    </svg>
  );
}

/** A4 invoice sheet; "Download PDF" prints only this sheet. */
export function InvoicePaper({ invoice: p, status, link, txHash, logo }: {
  invoice: PaperInvoice; status: PaperStatus; link?: string | null; txHash?: string | null; logo?: string | null;
}) {
  const totals = p.lines.map((l) => (l.quantity !== null && l.unitPrice !== null ? l.quantity * l.unitPrice : null));
  const subtotal = totals.reduce<bigint>((s, t) => s + (t ?? 0n), 0n);
  const total = subtotal + (p.tax?.amount ?? 0n);
  const supplier = p.supplierName.trim();

  return (
    <div className="paper-shell">
    <article className="invoice-paper" data-testid="invoice-paper" data-status={status}>
      <div className={`ip-stamp ip-stamp-${status}`} data-testid="paper-stamp">{status.toUpperCase()}</div>

      <header className="ip-head">
        <div className="ip-brand">
          {logo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="ip-logo" src={logo} alt="" />
            : <div className="ip-monogram" aria-hidden>{initials(supplier)}</div>}
          <div className="ip-supplier">{supplier || <span className="ip-faint">Supplier name</span>}</div>
        </div>
        <div className="ip-title">
          <div className="ip-word">INVOICE</div>
          <dl className="ip-meta">
            <dt>Number</dt><dd data-testid="paper-number">{p.id ?? <span className="ip-faint">Assigned on create</span>}</dd>
            <dt>Issued</dt><dd>{p.issued !== null ? day(p.issued) : <span className="ip-faint">On create</span>}</dd>
            <dt>Due</dt><dd>{p.due !== null ? day(p.due) : <span className="ip-faint">Not set</span>}</dd>
          </dl>
        </div>
      </header>

      <section className="ip-parties">
        <Party label="Bill to" value={p.buyer} />
        <Party label="Pay to" value={p.payee} />
      </section>

      <table className="ip-lines">
        <thead><tr><th>Description</th><th className="ip-n">Qty</th><th className="ip-n">Unit price</th><th className="ip-n">Amount</th></tr></thead>
        <tbody>
          {p.lines.map((l, n) => (
            <tr key={n}>
              <td>{l.description.trim() || <span className="ip-faint">Line {n + 1}</span>}</td>
              <td className="ip-n">{l.quantity !== null ? l.quantity.toString() : '—'}</td>
              <td className="ip-n">{l.unitPrice !== null ? money(l.unitPrice) : '—'}</td>
              <td className="ip-n">{totals[n] !== null ? money(totals[n]!) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="ip-sums">
        <div className="ip-sum"><span>Subtotal</span><span className="ip-n" data-testid="paper-subtotal">{money(subtotal)}</span></div>
        {p.tax && <div className="ip-sum"><span>{p.tax.label} {p.tax.rate}%</span><span className="ip-n" data-testid="paper-tax">{money(p.tax.amount)}</span></div>}
        <div className="ip-due">
          <span>Total due</span>
          <span className="ip-n"><span data-testid="paper-total">{money(total)}</span> <span className="ip-unit">USDT</span></span>
        </div>
      </div>

      <section className="ip-pay">
        <div className="ip-qr-wrap">
          <div className="ip-label">Scan to pay</div>
          {link ? <Qr link={link} /> : <div className="ip-qr-box ip-faint" data-testid="paper-qr-placeholder">QR appears when you create the link</div>}
        </div>
        <div className="ip-pay-text">
          {status === 'paid' && (
            <div className="ip-paid">Paid{txHash && <> · <a className="ip-mono" href={`${config.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">{short(txHash)}</a></>}</div>
          )}
          {link && (
            <div className="ip-actions">
              <button
                type="button" className="btn btn-sm" data-testid="paper-copy-link" data-link={link}
                onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Payment link copied'), () => toast('Could not copy; open the link instead', 'error'))}
              >Copy payment link</button>
              <a className="btn btn-sm btn-ghost" data-testid="paper-open-link" href={link} target="_blank" rel="noreferrer">Open</a>
            </div>
          )}
        </div>
      </section>

      <footer className="ip-foot">
        <div><span className="ip-label">Network</span> Whitechain (Sepolia testnet)</div>
        <div><span className="ip-label">Token</span> USDT</div>
        <div><span className="ip-label">Memo / PO</span> {p.memo.trim() || '—'}</div>
        <div className="ip-foot-note">Approve with a passkey · settles in seconds</div>
      </footer>
    </article>
    </div>
  );
}

/** Opens the print dialog; print styles keep only the invoice sheet. */
export const printInvoice = () => window.print();
