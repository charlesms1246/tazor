'use client';

import { useEffect, useState } from 'react';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { TIMINGS } from '@/lib/timings.ts';
import { ethCall } from '@/lib/rpc.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { loadMandates, loadPayments } from '@/lib/storage.ts';
import { usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { Addr, Card, KpiStrip, Notice, PageHeader, Pill, short } from './_ui/index.tsx';
import { fetchTransfers, nameOf, type Transfer } from '@/lib/activity.ts';

const ACCOUNT: Address = configV2.demoAccount;
const COMPANY = process.env.NEXT_PUBLIC_COMPANY_ENS || 'acme.taz0r.eth';

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : d.toISOString().slice(0, 10);
};

export default function Home() {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [mandates, setMandates] = useState(0);
  const [stamp, setStamp] = useState('');
  const [activity, setActivity] = useState<Transfer[] | null>(null);
  const [activityError, setActivityError] = useState(false);

  const loadActivity = () => {
    setActivityError(false);
    fetchTransfers(config.explorer, ACCOUNT, configV2.usdt).then(setActivity).catch(() => setActivityError(true));
  };

  const refresh = () => {
    setBalanceError(false);
    ethCall(configV2.usdt, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ACCOUNT] }))
      .then((h) => { setBalance(BigInt(h)); setStamp(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); })
      .catch(() => setBalanceError(true));
  };

  useEffect(() => {
    refresh();
    loadActivity();
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
        <Card title="Account activity" subtitle="USDT in and out of this account, from the Whitechain explorer." flush className="card-fill" testId="activity"
          actions={<a href={`${config.explorer}/address/${ACCOUNT}?tab=token_transfers`} target="_blank" rel="noreferrer" className="small">View all</a>}>
          {activity === null && !activityError && (
            <div style={{ padding: '0 24px 24px' }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ height: 52, display: 'flex', alignItems: 'center' }}><span className="skeleton" style={{ width: '100%' }} /></div>)}</div>
          )}
          {activityError && (
            <div style={{ padding: '0 24px 24px' }}><Notice tone="negative">Couldn&apos;t load activity from the explorer. <button className="btn btn-sm" onClick={loadActivity}>Retry</button></Notice></div>
          )}
          {activity && activity.length === 0 && (
            <div style={{ padding: '0 24px 24px' }}><p className="muted">No USDT has moved through this account yet.</p></div>
          )}
          {activity && activity.length > 0 && (
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Counterparty</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {activity.slice(0, 5).map((t) => {
                  const other = t.incoming ? t.from : t.to;
                  return (
                    <tr key={t.id}>
                      <td>{nameOf(other) ?? <span className="mono">{short(other)}</span>}
                        <span className="cell-sub">{t.incoming ? 'Received' : 'Paid'} · {when(t.time)}</span></td>
                      <td className="num"><span className={t.incoming ? 'in' : undefined}>{t.incoming ? '+' : '−'}{usdt2dp(t.amount)}</span> <span className="faint">USDT</span>
                        <span className="cell-sub"><a href={`${config.explorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer">Transaction</a></span></td>
                    </tr>
                  );
                })}
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
