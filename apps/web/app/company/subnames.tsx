'use client';

import { useEffect, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { configV2 } from '@/lib/config-v2.ts';
import { companySubnames, fetchLogs, type Subname } from '@/lib/ens-directory.ts';
import { labelOf } from '@/lib/people.ts';
import { decodeConfigV2, decodeWindowAvailable, encodeConfigV2Of, encodeWindowAvailable } from '@/lib/policies.ts';
import { ethCall } from '@/lib/rpc.ts';
import { Card, Empty, Notice, Pill } from '../_ui/index.tsx';
import { ensNameUrl } from './links.ts';

type AgentLimits = { cap: bigint; available: bigint } | null;

export const subnameKind = (label: string): 'contractor' | 'agent' | 'member' =>
  label.startsWith('contractor-') ? 'contractor' : /(^|-)agent($|-)/.test(label) ? 'agent' : 'member';

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** The company's ENS subnames: expiring contractors and agent namespaces, each linked to the ENS explorer. */
export function SubnamesCard({ ens, registry, account }: { ens: string; registry: Address | null; account: Address }) {
  const [subs, setSubs] = useState<Subname[] | null>(null);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState<AgentLimits>(null);

  useEffect(() => {
    setSubs(null); setError(''); setAgent(null);
    if (!registry) return;
    fetchLogs(registry).then((logs) => setSubs(companySubnames(logs)), (e) => setError(e instanceof Error ? e.message : String(e)));
    const pm = configV2.paymentModule;
    if (pm) {
      Promise.all([ethCall(pm, encodeConfigV2Of(account)).then(decodeConfigV2), ethCall(pm, encodeWindowAvailable(account)).then(decodeWindowAvailable)])
        .then(([c, w]) => setAgent({ cap: c.agentMonthlyCap, available: w[1] }), () => setAgent(null));
    }
  }, [registry, account]);

  const now = Date.now() / 1000;

  return (
    <Card title="Subnames" subtitle={<>ENS names under <span className="mono">{ens}</span>: contractors with an end date, and agents with spending limits.</>} flush testId="subnames">
      {!registry ? (
        <div style={{ padding: '0 24px 24px' }}><Empty>This company has no ENS registry yet.</Empty></div>
      ) : error ? (
        <div style={{ padding: '0 24px 24px' }}><Notice tone="negative">Couldn&apos;t read subnames from ENS ({error}).</Notice></div>
      ) : subs === null ? (
        <div style={{ padding: '0 24px 24px' }}><span className="skeleton" style={{ width: 240 }} /></div>
      ) : subs.length === 0 ? (
        <div style={{ padding: '0 24px 24px' }}><Empty>No subnames yet. An admin can register them on the company&apos;s ENS registry.</Empty></div>
      ) : (
        <div className="table-wrap"><table className="table table-stack">
          <thead><tr><th>Name</th><th>Kind</th><th>Holder</th><th>Expires</th></tr></thead>
          <tbody>
            {subs.map((s) => {
              const full = `${s.label}.${ens}`;
              const kind = subnameKind(s.label);
              const expired = s.expiry <= now;
              const soon = !expired && s.expiry - now < 30 * 86400;
              return (
                <tr key={s.label} data-testid="subname-row" data-label={s.label}>
                  <td><a className="mono break" href={ensNameUrl(full)} target="_blank" rel="noreferrer">{full}</a></td>
                  <td>
                    {kind === 'contractor' ? <Pill tone="warning">Contractor · expiring</Pill> : kind === 'agent' ? <Pill tone="info">Agent namespace</Pill> : <Pill>Member</Pill>}
                    {kind === 'agent' && (
                      <span className="cell-sub" data-testid="agent-limits">
                        {agent ? <>30-day cap {formatUnits(agent.cap, 6)} USDT · {formatUnits(agent.available, 6)} USDT available now (PaymentModule v2)</> : 'Limits not readable for this account'}
                      </span>
                    )}
                  </td>
                  <td>{labelOf(s.owner)}<span className="cell-sub mono">{`${s.owner.slice(0, 6)}…${s.owner.slice(-4)}`}</span></td>
                  <td className="num" data-testid="subname-expiry">
                    {day(s.expiry)}
                    {expired ? <span className="cell-sub">expired</span> : soon ? <span className="cell-sub">in {Math.ceil((s.expiry - now) / 86400)} days</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </Card>
  );
}
