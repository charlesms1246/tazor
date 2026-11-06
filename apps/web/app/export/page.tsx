'use client';

import { useEffect, useState } from 'react';
import { toCamt054, toQuickBooksCsv, toTallyCsv, toXeroCsv, usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { loadPayments } from '@/lib/storage.ts';
import { config } from '@/lib/config.ts';

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ExportPage() {
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [account, setAccount] = useState('');

  useEffect(() => {
    const list = loadPayments();
    setPayments(list);
    if (list[0]) setAccount(list[0].invoice.buyerAccount);
  }, []);

  const mine = payments.filter((p) =>
    [p.invoice.buyerAccount, p.invoice.payee, p.invoice.supplierAccount].some((a) => a.toLowerCase() === account.toLowerCase()));
  const accounts = [...new Set(payments.flatMap((p) => [p.invoice.buyerAccount, p.invoice.supplierAccount]))];
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <main>
      <h1>Export payments</h1>
      <p>Built in your browser from payments recorded on this device; nothing is sent anywhere.</p>
      {payments.length === 0 ? (
        <p data-testid="empty">No paid invoices recorded on this device yet.</p>
      ) : (
        <>
          <label>Account{' '}
            <select data-testid="account" value={account} onChange={(e) => setAccount(e.target.value)}>
              {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <table>
            <thead><tr><th>Date</th><th>Invoice</th><th>Counterparty</th><th>Amount (USDT)</th><th>Tx</th></tr></thead>
            <tbody>
              {mine.map((p) => (
                <tr key={p.txHash}>
                  <td>{new Date(p.blockTimestamp * 1000).toISOString().slice(0, 10)}</td>
                  <td>{p.invoice.id}</td>
                  <td>{p.invoice.supplierName}</td>
                  <td>{usdt2dp(p.invoice.amount)}</td>
                  <td><a href={`${config.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer">{p.txHash.slice(0, 10)}…</a></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <button data-testid="tally" onClick={() => download(`tazor-tally-${stamp}.csv`, 'text/csv', toTallyCsv(mine, account))}>Tally CSV</button>{' '}
            <button data-testid="xero" onClick={() => download(`tazor-xero-${stamp}.csv`, 'text/csv', toXeroCsv(mine, account))}>Xero CSV</button>{' '}
            <button data-testid="quickbooks" onClick={() => download(`tazor-quickbooks-${stamp}.csv`, 'text/csv', toQuickBooksCsv(mine, account))}>QuickBooks CSV</button>{' '}
            <button data-testid="camt" onClick={() => download(`tazor-camt054-${stamp}.xml`, 'application/xml', toCamt054(mine, account))}>ISO 20022 camt.054</button>
          </p>
        </>
      )}
    </main>
  );
}
