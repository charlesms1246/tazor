'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { toCamt054, toQuickBooksCsv, toTallyCsv, toXeroCsv, usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { loadPayments } from '@/lib/storage.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { fetchTransfers, nameOf, type Transfer } from '@/lib/activity.ts';
import { counterpartyOf, directionOf, toStatementCsv } from '@/lib/statement.ts';
import { Addr, Card, Empty, Field, Notice, PageHeader, short } from '../_ui/index.tsx';

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


const STATEMENT_ROWS = 10;

type StatementState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; transfers: Transfer[] };

function Statement({ accounts }: { accounts: string[] }) {
  const options = [...new Map([configV2.demoAccount, ...accounts].map((a) => [a.toLowerCase(), a])).values()];
  const [acct, setAcct] = useState<string>(configV2.demoAccount);
  const [state, setState] = useState<StatementState>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    fetchTransfers(config.explorer, acct as Address, configV2.usdt)
      .then((t) => setState({ status: 'ok', transfers: [...t].sort((a, b) => b.time.localeCompare(a.time)) }))
      .catch((e) => setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, [acct]);
  useEffect(load, [load]);

  const rows = state.status === 'ok' ? state.transfers : [];
  const explorerUrl = `${config.explorer}/address/${acct}?tab=token_transfers`;

  return (
    <Card
      title="On-chain statement"
      subtitle="USDT transfers for this account, read live from the Whitechain explorer."
      flush
      testId="statement"
      actions={<>
        <a className="small" href={explorerUrl} target="_blank" rel="noreferrer">View all on explorer</a>
        <button className="btn btn-sm" data-testid="statement-csv" disabled={rows.length === 0}
          onClick={() => download(`tazor-statement-${acct.slice(2, 10).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', toStatementCsv(rows))}>Download CSV</button>
      </>}
    >
      <div style={{ padding: '0 24px 16px' }}>
        <Field label="Account">
          <select className="select mono" data-testid="statement-account" value={acct} onChange={(e) => setAcct(e.target.value)}>
            {options.map((a) => <option key={a} value={a}>{nameOf(a as Address) ? `${nameOf(a as Address)} · ${short(a)}` : a}</option>)}
          </select>
        </Field>
      </div>
      {state.status === 'error' ? (
        <div style={{ padding: '0 24px 24px' }}>
          <Notice tone="negative">
            <span className="spread" style={{ width: '100%' }}>
              <span data-testid="statement-error">Couldn&apos;t load transfers from the explorer ({state.message}).</span>
              <button className="btn btn-sm" data-testid="statement-retry" onClick={load}>Retry</button>
            </span>
          </Notice>
        </div>
      ) : state.status === 'ok' && rows.length === 0 ? (
        <div style={{ padding: '0 24px 24px' }}><Empty><span data-testid="statement-empty">No USDT transfers for this account yet.</span></Empty></div>
      ) : (
        <div className="table-wrap"><table className="table table-stack" data-testid="statement-table">
          <thead><tr><th>Date</th><th>Counterparty</th><th>Direction</th><th className="num">Amount</th><th>Transaction</th></tr></thead>
          <tbody>
            {state.status === 'loading'
              ? [0, 1, 2].map((i) => (
                <tr key={i}>
                  <td><span className="skeleton" /></td><td><span className="skeleton" style={{ width: 140 }} /></td>
                  <td><span className="skeleton" style={{ minWidth: 60 }} /></td><td className="num"><span className="skeleton" /></td><td><span className="skeleton" /></td>
                </tr>
              ))
              : rows.slice(0, STATEMENT_ROWS).map((t) => {
                const cp = counterpartyOf(t);
                return (
                  <tr key={t.id} data-testid="statement-row">
                    <td className="tnum">{t.time.slice(0, 10)}</td>
                    <td>{nameOf(cp) ?? <span className="mono">{short(cp)}</span>}</td>
                    <td>{directionOf(t)}</td>
                    <td className="num" data-testid="statement-amount">
                      {t.incoming ? <span className="in">+{usdt2dp(t.amount)}</span> : <span>{'\u2212'}{usdt2dp(t.amount)}</span>} <span className="faint">USDT</span>
                    </td>
                    <td><Addr value={t.txHash} href={`${config.explorer}/tx/${t.txHash}`} /></td>
                  </tr>
                );
              })}
          </tbody>
        </table></div>
      )}
    </Card>
  );
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
                      <td className="tnum">{new Date(p.blockTimestamp * 1000).toISOString().slice(0, 10)}</td>
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
      <Statement accounts={accounts} />
    </div>
  );
}
