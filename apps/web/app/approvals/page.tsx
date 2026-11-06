'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { INBOX_CHANGED, loadInbox, type InboxItem, type InboxStatus } from '@/lib/inbox.ts';
import { Card, Empty, PageHeader, Pill } from '../_ui/index.tsx';
import './approvals.css';

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
  try { return v ? <>{formatUnits(BigInt(v), 6)} <span className="faint">USDT</span></> : <span className="faint">—</span>; } catch { return <span className="faint">—</span>; }
};
const approvalsText = (i: InboxItem) => (i.required ? `${i.approvals} of ${i.required} approvals` : `${i.approvals} approval${i.approvals === 1 ? '' : 's'}`);

export default function ApprovalsPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [tab, setTab] = useState<InboxStatus>('needs-approval');

  useEffect(() => {
    const sync = () => setItems(loadInbox().sort((a, b) => b.createdAt - a.createdAt));
    sync();
    addEventListener(INBOX_CHANGED, sync);
    addEventListener('storage', sync);
    return () => { removeEventListener(INBOX_CHANGED, sync); removeEventListener('storage', sync); };
  }, []);

  const count = (s: InboxStatus) => items.filter((i) => i.status === s).length;
  const shown = items.filter((i) => i.status === tab);

  return (
    <div className="page">
      <PageHeader title="Approvals" subtitle="Invoices, payment runs, mandates and role changes waiting for an approver on this device." />

      <div data-tour="approvals">
        <Card flush testId="approvals">
          <div className="tabs approvals-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.status} role="tab" className="tab" aria-selected={tab === t.status} data-testid={`approvals-tab-${t.status}`} onClick={() => setTab(t.status)}>
                {t.label}<span className="tab-count" data-testid={`approvals-count-${t.status}`}>{count(t.status)}</span>
              </button>
            ))}
          </div>

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
                  <tr key={i.id} data-testid="approval-row" data-kind={i.kind}>
                    <td><span className="kind-label">{KIND[i.kind] ?? i.kind}</span><span className="cell-sub" style={{ color: 'var(--text)' }}>{i.title}</span></td>
                    <td>{i.counterparty || <span className="faint">—</span>}</td>
                    <td className="num">{amount(i.amount)}</td>
                    <td className="num">{i.dueDate ? day(i.dueDate) : <span className="faint">—</span>}</td>
                    <td className="small">{approvalsText(i)}</td>
                    <td><Pill tone={PILL[i.status]?.tone ?? 'neutral'} testId="approval-status">{PILL[i.status]?.text ?? i.status}</Pill></td>
                    <td><a className="btn btn-sm" href={i.href} data-testid="approval-review">Review</a></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>
    </div>
  );
}
