'use client';

import { useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, erc20Abi } from 'viem';
import { ethCall } from '@/lib/rpc.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { loadMandates, loadPasskey, loadPayments } from '@/lib/storage.ts';
import { loadInvoices, type StoredInvoice } from '@/lib/invoices-store.ts';
import { usdt2dp, type PaymentRecord } from '@/lib/export.ts';
import { fetchTransfers, nameOf, type Transfer } from '@/lib/activity.ts';
import { dailyFlows, niceMax, sumFlows, type DayFlow } from '@/lib/dashboard.ts';
import { TIMINGS } from '@/lib/timings.ts';
import { Card, CopyButton, Notice, PageHeader, short } from './_ui/index.tsx';
import { Timeline } from './_ui/timeline.tsx';
import { startTour } from './_tour/tour.tsx';
import { useCompany, useDirectoryStatus } from '@/lib/company.ts';
import { DemoControls } from './_demo/demo-banner.tsx';
import { DEMO_CHANGED } from '@/lib/demo-seed.ts';
import { loadInbox, INBOX_CHANGED, type InboxItem } from '@/lib/inbox.ts';
import { recentEvents, EVENTS_CHANGED, type TimelineEvent } from '@/lib/events.ts';
import { isChainEvent, useHistory, useLatestEvents } from '@/lib/chain-history.ts';
import { approvalRows, chainPaidMap, companyLedger, summarize } from '@/lib/ledger.ts';
import { checkHealth, type Health } from '@/lib/health.ts';
import { loadPeople, type Person } from '@/lib/people.ts';
import { INR_RATE_NOTE, inrText, usdtNumber } from '@/lib/money.ts';
import { GetPaid } from './_home/get-paid.tsx';
import './_invoice/touch.css';
import { allCheckoutLogs, checkoutAddress, checkoutTotals, decodeCheckoutLogs, depositCheckoutAddress, merchantView } from '@/lib/checkout.ts';

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
  const company = useCompany();
  const dir = useDirectoryStatus();
  const ACCOUNT = company.account;
  const COMPANY = company.ens;
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const latest = useLatestEvents(ACCOUNT, 8);
  const history = useHistory(ACCOUNT);
  // Checkout revenue for this company (orders paid to it minus refunds), read from Whitechain's explorer
  const [checkoutSum, setCheckoutSum] = useState<ReturnType<typeof checkoutTotals> | null>(null);
  useEffect(() => {
    if ((!checkoutAddress() && !depositCheckoutAddress()) || !company.account || /^0x0{40}$/.test(company.account)) return;
    let live = true;
    allCheckoutLogs(4)
      .then((logs) => { if (live) setCheckoutSum(checkoutTotals(merchantView(decodeCheckoutLogs(logs), [company.account, ...company.aliases]).orders)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [company.account, company.aliases]);
  const [health, setHealth] = useState<Health | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
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
    setBalance(null); setActivity(null);
    if (company.status && company.status !== 'ready') return;
    refresh();
    loadActivity();
    setPeople(null);
    loadPeople(ACCOUNT).then(setPeople).catch(() => setPeople([]));
  }, [ACCOUNT, company.status]);

  useEffect(() => {
    checkHealth().then(setHealth);
    const syncInbox = () => setInbox(loadInbox());
    const syncEvents = () => setEvents(recentEvents(6));
    syncInbox(); syncEvents();
    globalThis.addEventListener(INBOX_CHANGED, syncInbox);
    globalThis.addEventListener(EVENTS_CHANGED, syncEvents);
    const syncAll = () => { setPayments(loadPayments()); setInvoices(loadInvoices()); setMandates(loadMandates().length); syncInbox(); syncEvents(); };
    globalThis.addEventListener(DEMO_CHANGED, syncAll);
    setPayments(loadPayments());
    setInvoices(loadInvoices());
    setMandates(loadMandates().length);
    setHasPasskey(loadPasskey() !== null);
    setReady(true);
    return () => { globalThis.removeEventListener(INBOX_CHANGED, syncInbox); globalThis.removeEventListener(EVENTS_CHANGED, syncEvents); globalThis.removeEventListener(DEMO_CHANGED, syncAll); };
  }, []);

  const flows = useMemo(() => (activity ? dailyFlows(activity, 7) : null), [activity]);
  const totals = flows ? sumFlows(flows) : null;

  const now = Date.now() / 1000;
  // the same numbers as /invoices and /approvals (lib/ledger.ts): device invoices + chain payments, one row per invoice
  const ledger = companyLedger({ company, invoices, payments, inbox, chainPaid: chainPaidMap(history.events), now });
  const receivables = summarize(ledger.sent);
  const open = ledger.sent.filter((r) => r.status !== 'paid');
  const overdue = ledger.sent.filter((r) => r.status === 'overdue');
  const openTotal = receivables.openTotal;

  const pending = approvalRows(inbox, history.events, company).rows.filter((r) => r.status === 'needs-approval');
  const pendingTotal = pending.reduce((s, i) => { try { return s + (i.amount ? BigInt(i.amount) : 0n); } catch { return s; } }, 0n);
  // a company that already moved money on chain is set up; the checklist is for new companies only
  const activeOnChain = (activity?.length ?? 0) > 0 || history.events.some(isChainEvent);
  const approvers = people?.filter((p) => p.roles.some((r) => /approver/i.test(r)) && p.whitechain !== 'revoked') ?? [];
  const syncing = people?.filter((p) => p.whitechain === 'syncing').length ?? 0;
  const revoked = people?.filter((p) => p.whitechain === 'revoked').length ?? 0;
  const healthy = health ? [health.relayer.ok || !health.relayer.configured, health.whitechain.ok, health.fallback.ready].filter(Boolean).length : 0;

  const steps = [
    { done: hasPasskey, title: 'Create your approver passkey', href: '/onboard/' },
    { done: invoices.length > 0, title: 'Create your first invoice', href: '/invoices/' },
    { done: payments.length > 0, title: 'Pay an invoice', href: '/approvals/' },
    { done: mandates > 0, title: 'Set up a direct debit', href: '/mandates/' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="page tz-touch">
      <PageHeader title="Home" subtitle={<>{COMPANY} · {company.role} · Whitechain Sepolia</>}
        actions={<button type="button" className="btn" data-testid="start-tour" onClick={() => startTour()}>Take the tour</button>} />

      {company.status === 'loading' && <div className="notice" data-testid="home-loading">Reading your companies from ENS…</div>}
      {company.status === 'error' && <div className="notice notice-negative" data-testid="home-ens-error">Couldn't read your companies from ENS. <button className="btn btn-sm" onClick={dir.retry}>Retry</button></div>}
      <div className="home-top">
        <section className="hero-card" aria-label="Balance" data-tour="balance">
          <div className="hero-label">Available balance</div>
          <div className="hero-value num">
            <span data-testid="balance">
              {balance === null
                ? (balanceError ? <span className="hero-muted">—</span> : <span className="skeleton dark" style={{ height: 36, width: 160 }} />)
                : usdt2dp(balance)}
            </span>
            <span className="hero-unit">USDT</span>
          </div>
          {balance !== null && <div className="hero-inr" style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }} title={INR_RATE_NOTE} data-testid="balance-inr">{inrText(balance)} · indicative</div>}
          <div className="hero-meta">
            <span className="mono">{short(ACCOUNT)}</span>
            <CopyButton value={ACCOUNT} label="Copy account address" />
            {balanceError
              ? <button type="button" className="hero-link" onClick={refresh}>Couldn&apos;t reach Whitechain · Retry</button>
              : stamp && <span>· updated {stamp}</span>}
          </div>
          <div className="hero-actions">
            <a className="btn btn-lime" href="/invoices/">Create invoice</a>
            <a className="btn btn-on-dark" href="/approvals/">Pay</a>
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

      <GetPaid />

      <section className="lanes" aria-label="Overview" data-tour="lanes">
        <a className="lane" href="/invoices/" data-testid="lane-receivables">
          <span className="lane-label">Receivables</span>
          <span className="lane-value num">{usdt2dp(openTotal)}<span className="kpi-unit">USDT</span></span>
          <span className="lane-sub">{open.length === 0 ? 'No unpaid invoices' : `${open.length} unpaid${overdue.length ? ` · ${overdue.length} overdue` : ''} · ${inrText(openTotal)}`}</span>
          {checkoutSum && checkoutSum.orders > 0 && (
            <span className="lane-sub" data-testid="lane-checkout">Checkout: {usdtNumber(checkoutSum.net)} USDT net from {checkoutSum.orders} order{checkoutSum.orders === 1 ? '' : 's'}{checkoutSum.refunded > 0n ? ` · ${usdtNumber(checkoutSum.refunded)} refunded` : ''}</span>
          )}
          {overdue.length > 0 && <span className="pill pill-negative lane-pill">Overdue</span>}
        </a>
        <a className="lane" href="/approvals/" data-testid="lane-payables">
          <span className="lane-label">Waiting for approval</span>
          <span className="lane-value num">{pending.length}</span>
          <span className="lane-sub">{pending.length === 0 ? 'Nothing to approve' : `${usdt2dp(pendingTotal)} USDT to approve`}</span>
          {pending.length > 0 && <span className="pill pill-info lane-pill">Review</span>}
        </a>
        <a className="lane" href="/company/" data-testid="lane-controls">
          <span className="lane-label">Approvers</span>
          <span className="lane-value num">{people === null ? '…' : approvers.length}</span>
          <span className="lane-sub">{people === null ? 'Reading roles from ENS…' : syncing ? `${syncing} syncing to Whitechain` : revoked ? `All in sync · ${revoked} removed` : 'All in sync with ENS'}</span>
        </a>
        <a className="lane" href="/security/" data-testid="lane-health">
          <span className="lane-label">System health</span>
          <span className="lane-value num">{health === null ? '…' : healthy === 3 ? 'All good' : `${healthy} of 3 ok`}</span>
          <span className="lane-sub">{health === null ? 'Checking…' : health.fallback.ready ? 'Ethereum fallback ready' : health.fallback.reason}</span>
          {health && <span className={`pill lane-pill ${healthy === 3 ? 'pill-positive' : 'pill-warning'}`}><span className="dot" />{health.whitechain.ok ? `Block ${health.whitechain.block?.toLocaleString('en-US')}` : 'Whitechain down'}</span>}
        </a>
      </section>

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
          {ready && doneCount < steps.length && !activeOnChain && (
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
          <DemoControls />
          <Card title="Latest events" subtitle="From the chain and this device, newest first" testId="events">
            {latest.loading && latest.events.length === 0 && events.length === 0
              ? <p className="muted">Reading the chain…</p>
              : (latest.events.length > 0 ? latest.events : events).length === 0
                ? <p className="muted">Invoices, approvals and payments show up here as a timeline.</p>
                : <Timeline events={(latest.events.length > 0 ? latest.events : events).slice(0, 8)} testId="home-events" />}
          </Card>
        </div>
      </div>
    </div>
  );
}
