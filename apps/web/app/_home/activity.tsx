'use client';

import { config } from '@/lib/config.ts';
import type { Transfer } from '@/lib/activity.ts';
import type { TimelineEvent } from '@/lib/events.ts';
import { usdt2dp } from '@/lib/export.ts';

type Row =
  | { kind: 'money'; at: number; key: string; t: Transfer; label: string | null }
  | { kind: 'event'; at: number; key: string; e: TimelineEvent };

const lc = (s?: string) => (s ?? '').toLowerCase();

/**
 * One activity list: each USDT movement once (named by the event that caused it, when known), plus the events that
 * moved no USDT here (approvals, role changes, refunds, syncs). Anything with a transaction appears once per hash.
 */
export function mergeActivity(transfers: Transfer[], events: TimelineEvent[], n = 8): Row[] {
  const byTx = new Map<string, TimelineEvent>();
  for (const e of events) if (e.tx && !byTx.has(lc(e.tx))) byTx.set(lc(e.tx), e);
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const t of transfers) {
    if (seen.has(lc(t.txHash))) continue;
    seen.add(lc(t.txHash));
    rows.push({ kind: 'money', at: Date.parse(t.time), key: `t-${t.id}`, t, label: byTx.get(lc(t.txHash))?.title ?? null });
  }
  events.forEach((e, i) => {
    if (e.tx) { if (seen.has(lc(e.tx))) return; seen.add(lc(e.tx)); }
    rows.push({ kind: 'event', at: e.at, key: `e-${e.kind}-${e.at}-${i}`, e });
  });
  return rows.sort((a, b) => b.at - a.at).slice(0, n);
}

const when = (ms: number) => new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const txUrl = (e: TimelineEvent) => (e.chain === 'sepolia' ? `${config.sepolia.explorer}/tx/${e.tx}` : `${config.explorer}/tx/${e.tx}`);

export function ActivityList({ rows, nameOf }: { rows: Row[]; nameOf: (a: string) => string | null }) {
  return (
    <div className="table-wrap"><table className="table activity-table">
      <tbody>
        {rows.map((r) => {
          if (r.kind === 'money') {
            const t = r.t;
            const other = t.incoming ? t.from : t.to;
            const name = nameOf(other);
            return (
              <tr key={r.key} data-testid="activity-row" data-kind="money">
                <td>
                  <span className="who">
                    <span className="avatar" aria-hidden="true">{(name ?? other.slice(2)).slice(0, 1).toUpperCase()}</span>
                    <span className="who-text">{r.label ?? name ?? <span className="mono">{short(other)}</span>}
                      <span className="cell-sub">{t.incoming ? 'Received' : 'Paid'}{r.label && name ? ` · ${name}` : ''} · {when(r.at)}</span></span>
                  </span>
                </td>
                <td className="num"><span className={t.incoming ? 'in' : undefined}>{t.incoming ? '+' : '−'}{usdt2dp(t.amount)}</span> <span className="faint">USDT</span>
                  <span className="cell-sub"><a href={`${config.explorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer">Transaction</a></span></td>
              </tr>
            );
          }
          const e = r.e;
          return (
            <tr key={r.key} data-testid="activity-row" data-kind={e.kind}>
              <td colSpan={2}>
                <span className="who">
                  <span className="avatar avatar-event" aria-hidden="true">•</span>
                  <span className="who-text">{e.title}
                    <span className="cell-sub">{when(e.at)}{e.actor ? ` · ${e.actor}` : ''}{e.detail ? ` · ${e.detail}` : ''}
                      {e.tx && <> · <a href={txUrl(e)} target="_blank" rel="noreferrer">{e.chain === 'sepolia' ? 'Ethereum transaction' : 'Transaction'}</a></>}</span></span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}
