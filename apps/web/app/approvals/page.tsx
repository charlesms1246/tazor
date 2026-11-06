'use client';

import { useEffect, useState } from 'react';
import { INBOX_CHANGED, loadInbox, type InboxItem, type InboxStatus } from '@/lib/inbox.ts';
import { useHistory, type ChainEvent } from '@/lib/chain-history.ts';
import { useCompany } from '@/lib/company.ts';
import { config } from '@/lib/config.ts';
import { partyName } from '@/lib/story.ts';
import { Card, Empty, PageHeader, Pill } from '../_ui/index.tsx';
import { OpenLinkBar, PaidFromDevice } from './open-link.tsx';
import './approvals.css';
import '../_invoice/touch.css';
import { usdtNumber } from '@/lib/money.ts';

const TABS: { status: InboxStatus; label: string }[] = [
  { status: 'needs-approval', label: 'Needs approval' },
  { status: 'approved', label: 'Approved' },
  { status: 'paid', label: 'Paid' },
];
const KIND: Record<InboxItem['kind'], string> = { invoice: 'Invoice', run: 'Payment run', mandate: 'Mandate', role: 'Role change' };
const PILL: Record<InboxStatus, { tone: 'warning' | 'info' | 'positive' | 'negative'; text: string }> = {
  'needs-approval': { tone: 'warning', text: 'Needs approval' },
  approved: { tone: 'info', text: 'Approved' },
  paid: { tone: 'positive', text: 'Paid' },
  declined: { tone: 'negative', text: 'Declined' },
};
const EMPTY: Record<InboxStatus, string> = {
  'needs-approval': 'Nothing is waiting for your approval. When a supplier sends you a payment link and you open it, it appears here.',
  approved: 'Nothing approved on this device yet.',
  paid: 'Nothing paid from this device yet.',
  declined: 'Nothing declined.',
};
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const amount = (v?: string) => {
  try { return v ? <>{usdtNumber(BigInt(v))} <span className="faint">USDT</span></> : <span className="faint">—</span>; } catch { return <span className="faint">—</span>; }
};
/** An inbox row built from an on-chain InvoicePaid this company paid. */
type Row = InboxItem & { chain?: ChainEvent };
const chainRow = (e: ChainEvent): Row => ({
  id: e.subject, kind: 'invoice', title: e.title.split(' paid: ')[0], counterparty: e.payee ? partyName(e.payee) : undefined,
  amount: e.amount, href: `${config.explorer}/tx/${e.tx}`, createdAt: e.at, status: 'paid', approvals: 0, chain: e,
});
const approvalsText = (i: InboxItem) => (i.required ? `${i.approvals} of ${i.required} approvals` : `${i.approvals} approval${i.approvals === 1 ? '' : 's'}`);

export default function ApprovalsPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [tab, setTab] = useState<InboxStatus>('needs-approval');
  const company = useCompany();
  const chain = useHistory(company.account);

  useEffect(() => {
    const sync = () => setItems(loadInbox().sort((a, b) => b.createdAt - a.createdAt));
    sync();
    addEventListener(INBOX_CHANGED, sync);
    addEventListener('storage', sync);
    return () => { removeEventListener(INBOX_CHANGED, sync); removeEventListener('storage', sync); };
  }, []);

  // what this company paid on chain (any device): marks device items paid, and adds the ones this device never saw
  const paidOnChain = chain.events.filter((e) => e.kind === 'paid' && e.payer?.toLowerCase() === company.account.toLowerCase());
  const bySubject = new Map(paidOnChain.map((e) => [e.subject.toLowerCase(), e]));
  const rows: Row[] = [
    ...items.map((i): Row => {
      const c = bySubject.get(i.id.toLowerCase());
      return c ? { ...i, status: 'paid', chain: c } : i;
    }),
    ...[...bySubject.values()].filter((e) => !items.some((i) => i.id.toLowerCase() === e.subject.toLowerCase())).map(chainRow),
  ];
  const count = (s: InboxStatus) => rows.filter((i) => i.status === s).length;
  const shown = rows.filter((i) => i.status === tab).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="page tz-touch">
      <PageHeader title="Approvals" subtitle="Open a payment link, and see invoices, payment runs, mandates and role changes waiting for an approver on this device." />

      <OpenLinkBar />

      <div data-tour="approvals">
        <Card flush testId="approvals">
          <div className="tabs approvals-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.status} role="tab" className="tab" aria-selected={tab === t.status} data-testid={`approvals-tab-${t.status}`} onClick={() => setTab(t.status)}>
                {t.label}<span className="tab-count" data-testid={`approvals-count-${t.status}`}>{count(t.status)}</span>
              </button>
            ))}
          </div>
          <p className="small faint" style={{ padding: '8px var(--card-pad) 0' }} data-testid="approvals-chain">
            {chain.loading ? `Reading ${company.name}'s payments from the chain…`
              : chain.error ? `Could not read the chain: ${chain.error}`
                : `${paidOnChain.length} payment${paidOnChain.length === 1 ? '' : 's'} by ${company.name} found on chain${chain.skipped.length ? ` (skipped: ${chain.skipped.map((x) => x.split(':')[0]).join(', ')})` : ''}.`}
          </p>

          {shown.length === 0 ? (
            <div style={{ padding: 'var(--card-pad)' }}>
              <Empty><span data-testid="approval-empty">{EMPTY[tab]}</span></Empty>
              <div className="approvals-summary" data-testid="approvals-summary">
                {TABS.map((t) => <span key={t.status}><b>{count(t.status)}</b> {t.label.toLowerCase()}</span>)}
              </div>
            </div>
          ) : (
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Item</th><th>Counterparty</th><th className="num">Amount</th><th>Due</th><th>Approvals</th><th>Status</th><th /></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} data-testid="approval-row" data-kind={i.kind} data-source={i.chain ? 'chain' : 'device'}>
                    <td><span className="kind-label">{KIND[i.kind] ?? i.kind}</span><span className="cell-sub" style={{ color: 'var(--text)' }}>{i.title}</span></td>
                    <td>{i.counterparty || <span className="faint">—</span>}</td>
                    <td className="num">{amount(i.amount)}</td>
                    <td className="num">{i.dueDate ? day(i.dueDate) : <span className="faint">—</span>}</td>
                    <td className="small">{i.chain && !i.approvals ? <span className="faint">—</span> : approvalsText(i)}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <Pill tone={PILL[i.status]?.tone ?? 'neutral'} testId="approval-status">{PILL[i.status]?.text ?? i.status}</Pill>
                        {i.chain && <Pill testId="approval-onchain">on-chain</Pill>}
                      </span>
                    </td>
                    <td>
                      {i.chain && i.chain.tx && i.href.startsWith(config.explorer)
                        ? <a className="btn btn-sm" href={i.href} target="_blank" rel="noreferrer" data-testid="approval-tx">View tx</a>
                        : <a className="btn btn-sm" href={i.href} data-testid="approval-review">Review</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>

      <PaidFromDevice />
    </div>
  );
}
