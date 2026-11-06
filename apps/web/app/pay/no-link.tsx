'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { config } from '@/lib/config.ts';
import { loadPayments } from '@/lib/storage.ts';
import type { PaymentRecord } from '@/lib/export.ts';
import { Addr, Card, Empty, Field, Notice, PageHeader } from '../_ui/index.tsx';
import { ScanQr } from './scan.tsx';
import '../_invoice/paper.css';
import '../_invoice/touch.css';

const amt = (v: bigint) => <>{formatUnits(v, 6)} <span className="faint">USDT</span></>;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** True for a payment link to this site's Pay page: <origin>/pay/#v1.… */
export function isPayLink(value: string, origin: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.origin === origin && u.pathname === '/pay/' && u.hash.startsWith('#v1.');
  } catch {
    return false;
  }
}

/** /pay/ opened without a link: open one, see what this device has paid, and how paying works. */
export function NoLink() {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [payments, setPayments] = useState<PaymentRecord[]>([]);

  useEffect(() => setPayments(loadPayments().sort((a, b) => b.blockTimestamp - a.blockTimestamp)), []);

  const onOpen = () => {
    if (!isPayLink(link, location.origin)) {
      return setError(`That is not a payment link for this site. It should look like ${location.origin}/pay/#v1.…`);
    }
    setError('');
    location.assign(link.trim());
  };

  return (
    <div className="page tz-touch">
      <PageHeader title="Pay an invoice" subtitle="Open the payment link your supplier sent you to check it and approve it with your passkey." />

      <div className="grid-2 stretch">
        <Card title="Open a payment link" subtitle="The invoice is encrypted inside the link and decrypted on this device.">
          <div className="stack">
            <Field label="Payment link">
              <input data-testid="open-link" className="input mono" value={link} onChange={(e) => { setLink(e.target.value); setError(''); }} placeholder="https://…/pay/#v1.…" />
            </Field>
            {error && <Notice tone="negative" testId="open-link-error">{error}</Notice>}
            <div className="row">
              <button data-testid="open-link-go" className="btn btn-primary" onClick={onOpen} disabled={!link.trim()}>Open</button>
            </div>
            <ScanQr />
          </div>
        </Card>

        <Card title="How paying works">
          <div className="steps">
            {[
              ['Open the link', 'The invoice is decrypted in your browser; nothing is sent to a server.'],
              ['Check the supplier and amount', 'The supplier shows as verified if its admin holds a WB Soul (simulated on testnet).'],
              ['Approve with your passkey', 'Face ID, fingerprint or device PIN unlocks your passkey; it signs exactly the invoice shown, after the page checks it against the contract.'],
              ['Paid on Whitechain', 'The relayer submits it in seconds; if the relayer is down, send it via Ethereum instead.'],
            ].map(([title, sub], i) => (
              <div className="step" key={title}>
                <span className="step-n">{i + 1}</span>
                <div><span style={{ fontWeight: 500 }}>{title}</span><span className="cell-sub">{sub}</span></div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Paid from this device" flush testId="paid-list">
        {payments.length === 0 ? (
          <div style={{ padding: '0 24px 24px' }}>
            <Empty><span data-testid="paid-empty">No payments from this device yet; open a payment link above to pay one.</span></Empty>
          </div>
        ) : (
          <div className="table-wrap"><table className="table table-stack">
            <thead><tr><th>Supplier</th><th className="num">Amount</th><th>Transaction</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.txHash} data-testid="paid-row">
                  <td>{p.invoice.supplierName}<span className="cell-sub">{p.invoice.id} · {day(p.blockTimestamp)}</span></td>
                  <td className="num">{amt(p.invoice.amount)}</td>
                  <td><Addr value={p.txHash} href={`${config.explorer}/tx/${p.txHash}`} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
