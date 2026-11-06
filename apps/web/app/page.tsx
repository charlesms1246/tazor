'use client';

import { useEffect, useState } from 'react';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { TIMINGS } from '@/lib/timings.ts';
import { ethCall } from '@/lib/rpc.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { loadMandates, loadPayments } from '@/lib/storage.ts';
import { usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { Addr, Card, KpiStrip, PageHeader, Pill } from './_ui/index.tsx';

const ACCOUNT: Address = configV2.demoAccount;
const COMPANY = process.env.NEXT_PUBLIC_COMPANY_ENS || 'acme.taz0r.eth';

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export default function Home() {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [mandates, setMandates] = useState(0);
  const [stamp, setStamp] = useState('');

  const refresh = () => {
    setBalanceError(false);
    ethCall(configV2.usdt, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ACCOUNT] }))
      .then((h) => { setBalance(BigInt(h)); setStamp(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); })
      .catch(() => setBalanceError(true));
  };

  useEffect(() => {
    refresh();
    setPayments(loadPayments().sort((a, b) => b.blockTimestamp - a.blockTimestamp));
    setMandates(loadMandates().length);
  }, []);

  const paidTotal = payments.reduce((s, p) => s + p.invoice.amount, 0n);

  return (
    <div className="page">
      <PageHeader
        title="Home"
        subtitle={<>Company account for <b style={{ fontWeight: 500, color: 'var(--text)' }}>{COMPANY}</b> on Whitechain Sepolia</>}
        actions={<>
          <a className="btn" href="/pay/">Pay an invoice</a>
          <a className="btn btn-primary" href="/invoices/">Create invoice</a>
        </>}
      />

      <KpiStrip items={[
        {
          lead: true, label: 'Available balance', unit: 'USDT', testId: 'balance',
          value: balance === null ? (balanceError ? <span className="faint">—</span> : <span className="skeleton" style={{ height: 28, width: 140 }} />) : usdt2dp(balance),
          zero: balance === 0n,
          sub: balanceError
            ? <>Couldn&apos;t reach Whitechain. <button className="btn-ghost" style={{ border: 0, padding: 0, color: 'var(--accent)', background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={refresh}>Retry</button></>
            : <>Account <Addr value={ACCOUNT} href={`${config.explorer}/address/${ACCOUNT}`} />{stamp && <> · updated {stamp}</>}</>,
        },
        { label: 'Paid from this device', value: usdt2dp(paidTotal), unit: 'USDT', zero: paidTotal === 0n, sub: `${payments.length} ${payments.length === 1 ? 'payment' : 'payments'}` },
        { label: 'Mandates set up here', value: String(mandates), zero: mandates === 0, sub: mandates === 0 ? <a href="/mandates/">Set up a direct debit</a> : <a href="/mandates/">View mandates</a> },
      ]} />

      <div className="grid-2 stretch">
        <Card title="Recent payments" flush className="card-fill" actions={payments.length > 0 ? <a href="/export/" className="small">View all</a> : undefined}>
          {payments.length === 0 ? (
            <div className="card-fill" style={{ padding: '0 24px 24px', flex: 1 }}>
              <p className="muted">No payments from this device yet. Paid invoices appear here with the amount, the supplier and their Whitechain transaction.</p>
              <div className="card-foot"><a className="btn btn-sm" href="/pay/">Pay an invoice</a></div>
            </div>
          ) : (
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Invoice</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {payments.slice(0, 5).map((p) => (
                  <tr key={p.txHash}>
                    <td>{p.invoice.supplierName}<span className="cell-sub">{p.invoice.id} · {day(p.blockTimestamp)}</span></td>
                    <td className="num">{usdt2dp(p.invoice.amount)} <span className="faint">USDT</span>
                      <span className="cell-sub"><a href={`${config.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer">Transaction</a></span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>

        <Card title="Get paid or pay" subtitle="Everything a finance team does each week.">
          <div className="stack" style={{ gap: 0 }}>
            {[
              ['/invoices/', 'Create an invoice', 'Send a payment link your customer approves with a passkey.'],
              ['/runs/', 'Run a payment batch', 'Approve several invoices with one signature.'],
              ['/mandates/', 'Set up a direct debit', 'Let a supplier collect a fixed amount each period, within limits.'],
              ['/financing/', 'Finance an invoice', 'Get paid now against an approved invoice.'],
            ].map(([href, title, sub], i) => (
              <a key={href} href={href} className="spread" style={{ padding: '12px 0', borderTop: i ? '1px solid var(--rule)' : 0, color: 'var(--text)' }}>
                <span><span style={{ fontWeight: 500 }}>{title}</span><span className="cell-sub">{sub}</span></span>
                <span className="faint" aria-hidden="true">→</span>
              </a>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Typical bank vs Tazor" subtitle="Measured on Whitechain Sepolia; each figure links its transaction." flush testId="timings">
        <div className="table-wrap"><table className="table table-stack">
          <thead><tr><th>Action</th><th>Typical bank</th><th>Tazor</th></tr></thead>
          <tbody>
            {TIMINGS.map((t) => (
              <tr key={t.action}>
                <td style={{ fontWeight: 500 }}>{t.action}</td>
                <td className="muted">{t.bank}</td>
                <td>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="num">{t.tazor}</span>
                    {t.status !== 'pending' && <Pill tone={t.status === 'measured' ? 'positive' : 'neutral'}>{t.status}</Pill>}
                  </span>
                  {t.proof && t.proof.length > 0 && (
                    <span className="cell-sub">{t.proof.map((p, i) => <span key={p.url}>{i > 0 && ' · '}<a href={p.url} target="_blank" rel="noreferrer">{p.label}</a></span>)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    </div>
  );
}
