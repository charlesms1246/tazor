'use client';

import { useEffect, useState, type ClipboardEvent } from 'react';
import { config } from '@/lib/config.ts';
import { loadPayments } from '@/lib/storage.ts';
import type { PaymentRecord } from '@/lib/export.ts';
import { isPayLink } from '../pay/no-link.tsx';
import { ScanQr } from '../pay/scan.tsx';
import { Card, Empty, Notice } from '../_ui/index.tsx';
import { usdtNumber } from '@/lib/money.ts';

/** Paste or scan the payment link a supplier sent, then open it on /pay/. */
export function OpenLinkBar() {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const onOpen = () => {
    if (!isPayLink(link, location.origin)) {
      return setError(`That is not a payment link for this site. It should look like ${location.origin}/pay/#v1.…`);
    }
    setError('');
    location.assign(link.trim());
  };
  // A pasted valid link opens straight away: one step fewer.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const v = e.clipboardData.getData('text').trim();
    if (v && isPayLink(v, location.origin)) { e.preventDefault(); setLink(v); setError(''); location.assign(v); }
  };
  return (
    <Card testId="open-link-bar">
      <label className="open-link-label" htmlFor="open-link">Open a payment link</label>
      <form className="open-link-bar" onSubmit={(e) => { e.preventDefault(); onOpen(); }}>
        <input id="open-link" data-testid="open-link" className="input mono" value={link} onChange={(e) => { setLink(e.target.value); setError(''); }} onPaste={onPaste} placeholder="Paste the link your supplier sent" autoComplete="off" spellCheck={false} inputMode="url" enterKeyHint="go" />
        <button type="submit" data-testid="open-link-go" className="btn btn-primary" disabled={!link.trim()}>Open</button>
        <div className="open-link-scan"><ScanQr /></div>
      </form>
      {error && <div style={{ marginTop: 12 }}><Notice tone="negative" testId="open-link-error">{error}</Notice></div>}
      <details className="open-link-how">
        <summary>How paying works</summary>
        <ol className="small muted">
          <li>Open the link: the invoice is decrypted in your browser; nothing is sent to a server.</li>
          <li>Check the supplier and amount: the supplier shows as verified if its admin holds a WB Soul (simulated on testnet).</li>
          <li>Approve with your passkey (Face ID, fingerprint or device PIN): it signs exactly the invoice shown, after the page checks it against the contract.</li>
          <li>Paid on Whitechain: the relayer submits it in seconds; if the relayer is down, send it via Ethereum instead.</li>
        </ol>
      </details>
    </Card>
  );
}

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** Payments this device submitted (kept on the device). */
export function PaidFromDevice() {
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  useEffect(() => setPayments(loadPayments().sort((a, b) => b.blockTimestamp - a.blockTimestamp)), []);
  return (
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
                <td className="num">{usdtNumber(p.invoice.amount)} <span className="faint">USDT</span></td>
                <td><a href={`${config.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer" data-value={p.txHash}>View transaction</a></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Card>
  );
}
