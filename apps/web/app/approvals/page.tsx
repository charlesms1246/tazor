'use client';

import { useEffect, useState } from 'react';
import { INBOX_CHANGED, loadInbox, type InboxItem, type InboxStatus } from '@/lib/inbox.ts';
import { useHistory } from '@/lib/chain-history.ts';
import { useCompany } from '@/lib/company.ts';
import { config } from '@/lib/config.ts';
import { partyName } from '@/lib/story.ts';
import { Card, Empty, PageHeader, Pill } from '../_ui/index.tsx';
import { OpenLinkBar, PaidFromDevice } from './open-link.tsx';
import './approvals.css';
import '../_invoice/touch.css';
import { usdtNumber } from '@/lib/money.ts';
import { approvalRows, type ApprovalRow } from '@/lib/ledger.ts';
import { Inr } from '../_invoice/inr.tsx';
import { decide, DECISIONS_CHANGED, loadDecisions, release, type Decision } from '@/lib/decisions.ts';

type Tab = InboxStatus | 'held';
const TABS: { status: Tab; label: string }[] = [
  { status: 'needs-approval', label: 'Needs approval' },
  { status: 'held', label: 'On hold / rejected' },
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
const EMPTY: Record<Tab, string> = {
  held: 'Nothing on hold or rejected.',
  'needs-approval': 'Nothing is waiting for your approval. When a supplier sends you a payment link and you open it, it appears here.',
  approved: 'Nothing approved on this device yet.',
  paid: 'Nothing paid from this device yet.',
  declined: 'Nothing declined.',
};
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const amount = (v?: string) => {
  try { return v ? <>{usdtNumber(BigInt(v))} <span className="faint">USDT</span></> : <span className="faint">—</span>; } catch { return <span className="faint">—</span>; }
};
/** Chain-only rows (paid elsewhere) get the payee's name and a link to the transaction. */
const withChainDetails = (r: ApprovalRow): ApprovalRow => (r.chain && !r.href
  ? { ...r, counterparty: r.chain.payee ? partyName(r.chain.payee) : undefined, href: `${config.explorer}/tx/${r.chain.tx}` }
  : r);
const approvalsText = (i: InboxItem) => (i.required ? `${i.approvals} of ${i.required} approvals` : `${i.approvals} approval${i.approvals === 1 ? '' : 's'}`);

export default function ApprovalsPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [tab, setTab] = useState<Tab>('needs-approval');
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [editing, setEditing] = useState<{ id: string; kind: Decision['kind'] } | null>(null);
  const [reason, setReason] = useState('');
  const [decideError, setDecideError] = useState('');
  useEffect(() => {
    const sync = () => setDecisions(loadDecisions());
    sync();
    addEventListener(DECISIONS_CHANGED, sync);
    return () => removeEventListener(DECISIONS_CHANGED, sync);
  }, []);
  const onSaveDecision = () => {
    if (!editing) return;
    try { decide(editing.id, editing.kind, reason); setEditing(null); setReason(''); setDecideError(''); } catch (e) { setDecideError(e instanceof Error ? e.message : String(e)); }
  };
  const company = useCompany();
  const chain = useHistory(company.account);

  useEffect(() => {
    const sync = () => setItems(loadInbox().sort((a, b) => b.createdAt - a.createdAt));
    sync();
    addEventListener(INBOX_CHANGED, sync);
    addEventListener('storage', sync);
    return () => { removeEventListener(INBOX_CHANGED, sync); removeEventListener('storage', sync); };
  }, []);

  // one list for the selected company (lib/ledger.ts): device items + what it paid on chain, one row per invoice;
  // the tab counts, the rows and the "found on chain" line all come from it, so they always agree
  const ledger = approvalRows(items, chain.events, company);
  const rows = ledger.rows.map(withChainDetails);
  const paidOnChain = ledger.paidOnChain;
  // a hold or rejection (local) takes an item out of Needs approval until it is released; paid/approved stay as they are
  const decisionOf = (r: ApprovalRow) => (r.status === 'needs-approval' ? decisions[r.id.toLowerCase()] ?? null : null);
  const tabOf = (r: ApprovalRow): Tab => (decisionOf(r) ? 'held' : r.status);
  const count = (s: Tab) => rows.filter((r) => tabOf(r) === s).length;
  const shown = rows.filter((i) => tabOf(i) === tab).sort((a, b) => b.createdAt - a.createdAt);

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
                : `${paidOnChain} payment${paidOnChain === 1 ? '' : 's'} by ${company.name} found on chain${chain.skipped.length ? ` (skipped: ${chain.skipped.map((x) => x.split(':')[0]).join(', ')})` : ''}.`}
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
                    <td className="num">{amount(i.amount)}{i.amount && /^\d+$/.test(i.amount) && <span className="cell-sub"><Inr v={BigInt(i.amount)} /></span>}</td>
                    <td className="num">{i.dueDate ? day(i.dueDate) : <span className="faint">—</span>}</td>
                    <td className="small">{i.chain && !i.approvals ? <span className="faint">—</span> : approvalsText(i)}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <Pill tone={PILL[i.status]?.tone ?? 'neutral'} testId="approval-status">{PILL[i.status]?.text ?? i.status}</Pill>
                        {i.chain && <Pill testId="approval-onchain">on-chain</Pill>}
                        {decisionOf(i) && (
                          <span title="Saved on this device only, until Tazor has a shared backend">
                            <Pill tone={decisionOf(i)!.kind === 'reject' ? 'negative' : 'warning'} testId="approval-decision">{decisionOf(i)!.kind === 'reject' ? 'Rejected' : 'On hold'} · local</Pill>
                          </span>
                        )}
                      </span>
                      {decisionOf(i) && <span className="cell-sub" data-testid="approval-reason-text">“{decisionOf(i)!.reason}”</span>}
                    </td>
                    <td>
                      {i.chain && i.chain.tx && i.href.startsWith(config.explorer)
                        ? <a className="btn btn-sm" href={i.href} target="_blank" rel="noreferrer" data-testid="approval-tx">View tx</a>
                        : <a className="btn btn-sm" href={i.href} data-testid="approval-review">Review</a>}
                      {i.status === 'needs-approval' && !decisionOf(i) && (
                        <span className="row" style={{ gap: 4, marginTop: 6 }}>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="approval-hold" onClick={() => { setEditing({ id: i.id, kind: 'hold' }); setReason(''); setDecideError(''); }}>Hold</button>
                          <button type="button" className="btn btn-sm btn-ghost" data-testid="approval-reject" onClick={() => { setEditing({ id: i.id, kind: 'reject' }); setReason(''); setDecideError(''); }}>Reject</button>
                        </span>
                      )}
                      {decisionOf(i) && <button type="button" className="btn btn-sm btn-ghost" data-testid="approval-release" style={{ marginTop: 6 }} onClick={() => release(i.id)}>Release</button>}
                      {editing?.id === i.id && (
                        <span className="stack decision-form" style={{ gap: 6, marginTop: 8 }}>
                          <input data-testid="approval-reason" className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={280}
                            placeholder={editing.kind === 'hold' ? 'Why hold it? e.g. waiting for the PO' : 'Why reject it? e.g. duplicate of INV-…'} aria-label="Reason" />
                          <span className="row" style={{ gap: 4 }}>
                            <button type="button" className="btn btn-sm" data-testid="approval-decide-save" onClick={onSaveDecision}>{editing.kind === 'hold' ? 'Hold' : 'Reject'} (this device)</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                          </span>
                          {decideError && <span className="small" style={{ color: 'var(--negative)' }} data-testid="approval-reason-error">{decideError}</span>}
                        </span>
                      )}
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
