'use client';

import { useEffect, useState } from 'react';
import { toCamt054, toQuickBooksCsv, toTallyCsv, toXeroCsv, usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { loadPayments } from '@/lib/storage.ts';
import { config } from '@/lib/config.ts';
import { Addr, Card, Empty, Field, PageHeader } from '../_ui/index.tsx';

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
    <div className="page">
      <PageHeader title="Reports" subtitle="Accounting exports built in your browser from payments recorded on this device; nothing is sent anywhere." />
      {payments.length === 0 ? (
        <Card>
          <div data-testid="empty"><Empty>No paid invoices recorded on this device yet. Pay an invoice and it appears here, ready to export.</Empty></div>
          <div style={{ marginTop: 16 }}><a className="btn btn-sm" href="/pay/">Pay an invoice</a></div>
        </Card>
      ) : (
        <>
          <Card title="Export" subtitle="Tally, Xero and QuickBooks bank-statement CSVs, or an ISO 20022 camt.054-style notification (USDT, 6 dp; not XSD-valid).">
            <div className="fields">
              <Field label="Account">
                <select className="select mono" data-testid="account" value={account} onChange={(e) => setAccount(e.target.value)}>
                  {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <div className="row">
                <button className="btn btn-primary" data-testid="tally" onClick={() => download(`tazor-tally-${stamp}.csv`, 'text/csv', toTallyCsv(mine, account))}>Tally CSV</button>
                <button className="btn" data-testid="xero" onClick={() => download(`tazor-xero-${stamp}.csv`, 'text/csv', toXeroCsv(mine, account))}>Xero CSV</button>
                <button className="btn" data-testid="quickbooks" onClick={() => download(`tazor-quickbooks-${stamp}.csv`, 'text/csv', toQuickBooksCsv(mine, account))}>QuickBooks CSV</button>
                <button className="btn" data-testid="camt" onClick={() => download(`tazor-camt054-${stamp}.xml`, 'application/xml', toCamt054(mine, account))}>ISO 20022 camt.054</button>
              </div>
            </div>
          </Card>
          <Card title="Payments" subtitle={`${mine.length} ${mine.length === 1 ? 'payment' : 'payments'} for this account.`} flush>
            {mine.length === 0 ? <div style={{ padding: '0 24px 24px' }}><Empty>No payments for this account. Pick another account above.</Empty></div> : (
              <div className="table-wrap"><table className="table table-stack">
                <thead><tr><th>Date</th><th>Invoice</th><th>Counterparty</th><th className="num">Amount</th><th>Transaction</th></tr></thead>
                <tbody>
                  {mine.map((p) => (
                    <tr key={p.txHash}>
                      <td className="num">{new Date(p.blockTimestamp * 1000).toISOString().slice(0, 10)}</td>
                      <td>{p.invoice.id}</td>
                      <td>{p.invoice.supplierName}</td>
                      <td className="num">{usdt2dp(p.invoice.amount)} <span className="faint">USDT</span></td>
                      <td><Addr value={p.txHash} href={`${config.explorer}/tx/${p.txHash}`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
