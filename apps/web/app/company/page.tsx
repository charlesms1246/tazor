'use client';

import { useEffect, useState } from 'react';
import { config } from '@/lib/config.ts';
import { useCompany } from '@/lib/company.ts';
import { agoText, loadPeople, type Person } from '@/lib/people.ts';
import { Addr, Card, Empty, Notice, PageHeader, Pill } from '../_ui/index.tsx';

const SYNC_SECONDS = 84;

const STATUS: Record<Person['whitechain'], { tone: 'positive' | 'info' | 'warning' | 'negative' | 'neutral'; text: string }> = {
  'in-sync': { tone: 'positive', text: 'In sync' },
  syncing: { tone: 'info', text: 'Syncing… ~1 min' },
  'out-of-sync': { tone: 'warning', text: 'Out of sync' },
  revoked: { tone: 'negative', text: 'Revoked' },
  unknown: { tone: 'neutral', text: 'Unknown' },
};

const SOUL: Record<Person['soul'], { tone: 'positive' | 'warning' | 'neutral'; text: string }> = {
  verified: { tone: 'positive', text: 'Verified' },
  unverified: { tone: 'warning', text: 'Not verified' },
  unknown: { tone: 'neutral', text: 'Unknown' },
};

export default function CompanyPage() {
  const company = useCompany();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setPeople(null);
    setError('');
    loadPeople(company.account).then(setPeople, (e) => setError(e instanceof Error ? e.message : String(e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [company.account]);

  return (
    <div className="page">
      <PageHeader title="Company" subtitle="Who your company is on ENS, who acts for it, and whether Whitechain agrees." />

      <Card title={company.name} subtitle="Company profile" testId="company-profile"
        actions={<>
          <a className="btn btn-sm" href={`https://sepolia.app.ens.domains/${company.ens}`} target="_blank" rel="noreferrer">View on ENS</a>
          <a className="btn btn-sm" href={`${config.explorer}/address/${company.account}`} target="_blank" rel="noreferrer">Explorer</a>
        </>}>
        <dl className="kv">
          <dt>ENS name</dt><dd className="mono" data-testid="company-ens">{company.ens}</dd>
          <dt>Name</dt><dd>{company.name}</dd>
          <dt>Role in the demo</dt><dd><Pill tone="info">{company.role}</Pill></dd>
          <dt>Account on Whitechain</dt><dd><Addr value={company.account} href={`${config.explorer}/address/${company.account}`} /></dd>
        </dl>
      </Card>

      <div data-tour="people">
        <Card title="People" subtitle="Admin signers of the account and the people who act for it. WB Soul status is simulated on testnet." flush
          actions={<button className="btn btn-sm" onClick={load}>Refresh</button>}>
          {error ? (
            <div style={{ padding: '0 24px 24px' }}><Notice tone="negative">Couldn&apos;t read the team from Whitechain and ENS ({error}). <button className="btn btn-sm" onClick={load}>Retry</button></Notice></div>
          ) : people && people.length === 0 ? (
            <div style={{ padding: '0 24px 24px' }}><Empty>No people found for this account yet. Add an approver role on the company&apos;s ENS name.</Empty></div>
          ) : (
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Person</th><th>Roles</th><th>WB Soul (simulated)</th><th>Whitechain</th></tr></thead>
              <tbody>
                {people === null
                  ? [0, 1, 2].map((i) => <tr key={i}><td><span className="skeleton" style={{ width: 160 }} /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td></tr>)
                  : people.map((p) => (
                    <tr key={p.address} data-testid="person-row" data-address={p.address.toLowerCase()}>
                      <td>
                        <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                          <span className="avatar" aria-hidden="true">{p.label.charAt(0).toUpperCase()}</span>
                          <span><span style={{ fontWeight: 500 }}>{p.label}</span><span className="cell-sub mono">{`${p.address.slice(0, 6)}…${p.address.slice(-4)}`}</span></span>
                        </span>
                      </td>
                      <td><span className="row">{p.roles.length ? p.roles.map((r) => <Pill key={r}>{r}</Pill>) : <span className="faint">none</span>}</span></td>
                      <td><Pill tone={SOUL[p.soul].tone}>{SOUL[p.soul].text}</Pill></td>
                      <td>
                        <Pill tone={STATUS[p.whitechain].tone} testId="person-status">{STATUS[p.whitechain].text}</Pill>
                        {p.whitechain === 'out-of-sync' && (
                          <span className="cell-sub" data-testid="person-sync-note">
                            ENS and the role cache disagree. Role cache last synced {p.cacheAgeSec !== undefined ? agoText(p.cacheAgeSec) : 'at an unknown time'}
                            {p.cachedAt ? ` (L1 block ${p.cachedAt.toLocaleString('en-US')})` : ''}; run syncRoles. <a href="/docs/company-on-ens/#how-a-role-change-reaches-whitechain">How to sync</a>
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

      <Card title="How roles flow" subtitle={<>Your ENS name is the source of truth; Whitechain enforces it. <a href="/docs/company-on-ens/">How it works</a></>}>
        <div className="grid-3">
          <div className="well">
            <div className="small faint">1 · Ethereum</div>
            <div style={{ fontWeight: 500, marginTop: 4 }}>Roles live on ENS</div>
            <p className="small muted" style={{ marginTop: 4 }}>An admin grants or removes a role on <span className="mono">{company.ens}</span>.</p>
          </div>
          <div className="well">
            <div className="small faint">2 · Proof</div>
            <div style={{ fontWeight: 500, marginTop: 4 }}>Proven to Whitechain</div>
            <p className="small muted" style={{ marginTop: 4 }}>The watcher submits a storage proof to the role cache. Measured: <span className="num">{SYNC_SECONDS} s</span> from ENS change to cached role.</p>
          </div>
          <div className="well">
            <div className="small faint">3 · Whitechain</div>
            <div style={{ fontWeight: 500, marginTop: 4 }}>Enforced on payment</div>
            <p className="small muted" style={{ marginTop: 4 }}>Every payment checks the cached role, WB Soul and the revocation list before USDT moves.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
