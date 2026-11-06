'use client';

import { useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { ethCall } from '@/lib/rpc.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { loadMandates, loadPasskey, loadPayments } from '@/lib/storage.ts';
import { loadInvoices, invoiceStatus, type StoredInvoice } from '@/lib/invoices-store.ts';
import { usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { fetchTransfers, nameOf, type Transfer } from '@/lib/activity.ts';
import { dailyFlows, niceMax, sumFlows, type DayFlow } from '@/lib/dashboard.ts';
import { TIMINGS } from '@/lib/timings.ts';
import { Card, CopyButton, Notice, PageHeader, short } from './_ui/index.tsx';

const ACCOUNT: Address = configV2.demoAccount;
const COMPANY = process.env.NEXT_PUBLIC_COMPANY_ENS || 'acme.taz0r.eth';
const PAY_TIME = TIMINGS.find((t) => t.action.startsWith('Pay an approved'))?.tazor ?? '';

const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : d.toISOString().slice(0, 10);
};
const whole = (base: bigint) => (Number(base) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function FlowChart({ rows }: { rows: DayFlow[] }) {
  const W = 640, H = 200, L = 40, R = 8, T = 8, B = 24;
  const max = niceMax(rows.reduce((m, r) => (r.in > m ? r.in : r.out > m ? r.out : m), 0n));
  const mid = T + (H - T - B) / 2;
  const half = (H - T - B) / 2;
  const step = (W - L - R) / rows.length;
  const bw = Math.max(4, step * 0.56);
  const y = (base: bigint) => (Number(base) / 1e6 / max) * half;
  const ticks = [max, max / 2, 0, -max / 2, -max];
  return (
    <svg className="flow-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="USDT received and paid per day">
      {ticks.map((v) => {
        const ty = mid - (v / max) * half;
        return (
          <g key={v}>
            <line x1={L} x2={W - R} y1={ty} y2={ty} className={v === 0 ? 'axis' : 'grid'} />
            <text x={L - 8} y={ty + 4} textAnchor="end" className="tick">{v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`}</text>
          </g>
        );
      })}
      {rows.map((r, i) => {
        const x = L + i * step + (step - bw) / 2;
        const hin = y(r.in), hout = y(r.out);
        return (
          <g key={r.day}>
            <title>{`${r.day}: +${usdt2dp(r.in)} received, −${usdt2dp(r.out)} paid`}</title>
            {r.in > 0n && <rect x={x} y={mid - hin} width={bw} height={Math.max(1, hin)} className="bar-in" />}
            {r.out > 0n && <rect x={x} y={mid} width={bw} height={Math.max(1, hout)} className="bar-out" />}
            {<text x={x + bw / 2} y={H - 6} textAnchor="middle" className="tick">{new Date(r.day + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function Home() {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const [stamp, setStamp] = useState('');
  const [activity, setActivity] = useState<Transfer[] | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [mandates, setMandates] = useState(0);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = () => {
    setBalanceError(false);
    ethCall(configV2.usdt, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ACCOUNT] }))
      .then((h) => { setBalance(BigInt(h)); setStamp(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); })
      .catch(() => setBalanceError(true));
  };
  const loadActivity = () => {
    setActivityError(false);
    fetchTransfers(config.explorer, ACCOUNT, configV2.usdt).then(setActivity).catch(() => setActivityError(true));
  };

  useEffect(() => {
    refresh();
    loadActivity();
    setPayments(loadPayments());
    setInvoices(loadInvoices());
    setMandates(loadMandates().length);
    setHasPasskey(loadPasskey() !== null);
    setReady(true);
  }, []);

  const flows = useMemo(() => (activity ? dailyFlows(activity, 7) : null), [activity]);
  const totals = flows ? sumFlows(flows) : null;

  const now = Date.now() / 1000;
  const open = invoices.filter((s) => invoiceStatus(s.invoice, payments) !== 'paid');
  const overdue = open.filter((s) => s.invoice.dueDate < now);
  const awaiting = open.filter((s) => s.invoice.dueDate >= now);
  const openTotal = open.reduce((s, i) => s + i.invoice.amount, 0n);

  const steps = [
    { done: hasPasskey, title: 'Create your approver passkey', href: '/onboard/' },
    { done: invoices.length > 0, title: 'Create your first invoice', href: '/invoices/' },
    { done: payments.length > 0, title: 'Pay an invoice', href: '/pay/' },
    { done: mandates > 0, title: 'Set up a direct debit', href: '/mandates/' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="page">
      <PageHeader title="Home" subtitle={<>{COMPANY} · Whitechain Sepolia</>} />

      <div className="home-top">
        <section className="hero-card" aria-label="Balance">
          <div className="hero-label">Available balance</div>
          <div className="hero-value num">
            <span data-testid="balance">
              {balance === null
                ? (balanceError ? <span className="hero-muted">—</span> : <span className="skeleton dark" style={{ height: 36, width: 160 }} />)
                : usdt2dp(balance)}
            </span>
            <span className="hero-unit">USDT</span>
          </div>
          <div className="hero-meta">
            <span className="mono">{short(ACCOUNT)}</span>
            <CopyButton value={ACCOUNT} label="Copy account address" />
            {balanceError
              ? <button type="button" className="hero-link" onClick={refresh}>Couldn&apos;t reach Whitechain · Retry</button>
              : stamp && <span>· updated {stamp}</span>}
          </div>
          <div className="hero-actions">
            <a className="btn btn-lime" href="/invoices/">Create invoice</a>
            <a className="btn btn-on-dark" href="/pay/">Pay</a>
            <a className="btn btn-on-dark" href="/mandates/">Collect</a>
          </div>
          {PAY_TIME && (
            <a className="hero-badge" href="/docs/timings/" data-testid="speed-badge">
              <span className="dot" />Payments settle in {PAY_TIME} on Whitechain · see how we measured
            </a>
          )}
        </section>

        <Card title="Money in and out" subtitle="Last 7 days, from the Whitechain explorer" testId="flows">
          <div className="flow-totals">
            <div><div className="kpi-label">Received</div><div className="flow-figure num">{totals ? `+${whole(totals.in)}` : '…'}<span className="kpi-unit">USDT</span></div></div>
            <div><div className="kpi-label">Paid</div><div className="flow-figure num">{totals ? `−${whole(totals.out)}` : '…'}<span className="kpi-unit">USDT</span></div></div>
            <div className="legend"><span><i className="sw-in" />Received</span><span><i className="sw-out" />Paid</span></div>
          </div>
          {activityError && <Notice tone="negative">Couldn&apos;t load transfers from the explorer. <button className="btn btn-sm" onClick={loadActivity}>Retry</button></Notice>}
          {!activityError && (flows ? <FlowChart rows={flows} /> : <div className="skeleton" style={{ height: 200, width: '100%' }} />)}
        </Card>
      </div>

      <div className="home-bottom">
        <Card title="Recent activity" flush testId="activity" actions={<a href="/export/" className="small">Statement</a>}>
          {activity === null && !activityError && (
            <div style={{ padding: '0 24px 24px' }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ height: 52, display: 'flex', alignItems: 'center' }}><span className="skeleton" style={{ width: '100%' }} /></div>)}</div>
          )}
          {activityError && <div style={{ padding: '0 24px 24px' }}><p className="muted">Activity is unavailable while the explorer can&apos;t be reached.</p></div>}
          {activity && activity.length === 0 && <div style={{ padding: '0 24px 24px' }}><p className="muted">No USDT has moved through this account yet.</p></div>}
          {activity && activity.length > 0 && (
            <div className="table-wrap"><table className="table">
              <tbody>
                {activity.slice(0, 6).map((t) => {
                  const other = t.incoming ? t.from : t.to;
                  const name = nameOf(other);
                  return (
                    <tr key={t.id}>
                      <td>
                        <span className="who">
                          <span className="avatar" aria-hidden="true">{(name ?? other.slice(2)).slice(0, 1).toUpperCase()}</span>
                          <span className="who-text">{name ?? <span className="mono">{short(other)}</span>}<span className="cell-sub">{t.incoming ? 'Received' : 'Paid'} · {when(t.time)}</span></span>
                        </span>
                      </td>
                      <td className="num"><span className={t.incoming ? 'in' : undefined}>{t.incoming ? '+' : '−'}{usdt2dp(t.amount)}</span> <span className="faint">USDT</span>
                        <span className="cell-sub"><a href={`${config.explorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer">Transaction</a></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </Card>

        <div className="stack">
          <Card title="Needs your attention" testId="attention">
            {!ready ? <span className="skeleton" style={{ width: '100%' }} /> : overdue.length + awaiting.length === 0 ? (
              <p className="muted">Nothing is waiting on you. Invoices you send stay here until they&apos;re paid.</p>
            ) : (
              <ul className="attention">
                {overdue.length > 0 && (
                  <li><a href="/invoices/"><span><b>{overdue.length} overdue {overdue.length === 1 ? 'invoice' : 'invoices'}</b><span className="cell-sub">Past their due date and unpaid</span></span><span className="pill pill-negative">Overdue</span></a></li>
                )}
                {awaiting.length > 0 && (
                  <li><a href="/invoices/"><span><b>{awaiting.length} awaiting payment</b><span className="cell-sub">{usdt2dp(openTotal)} USDT outstanding</span></span><span className="pill pill-info">Sent</span></a></li>
                )}
              </ul>
            )}
          </Card>

          {ready && doneCount < steps.length && (
            <Card title="Get set up" subtitle={`${doneCount} of ${steps.length} done`} testId="setup">
              <div className="progress" aria-hidden="true"><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
              <ul className="checklist">
                {steps.map((s) => (
                  <li key={s.title} data-done={s.done}>
                    <span className="check-dot" aria-hidden="true" />
                    {s.done ? <span className="muted">{s.title}</span> : <a href={s.href}>{s.title}</a>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
