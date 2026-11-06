'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import './company.css';
import { config } from '@/lib/config.ts';
import { useCompany } from '@/lib/company.ts';
import { agoText, companyRegistry, loadPeople, type Person } from '@/lib/people.ts';
import { PersonDrawer } from './drawer.tsx';
import { SoulStatus } from '@/app/_soul/soul-badge.tsx';
import { BackupSigner } from './backup.tsx';
import { RemovePerson } from './remove.tsx';
import { ensNameUrl, ensRegistryUrl, ensRolesUrl, registryEventsUrl } from './links.ts';
import { Addr, Card, Empty, Notice, PageHeader, Pill } from '../_ui/index.tsx';

const SYNC_SECONDS = 84;

const STATUS: Record<Person['whitechain'], { tone: 'positive' | 'info' | 'warning' | 'negative' | 'neutral'; text: string }> = {
  'in-sync': { tone: 'positive', text: 'In sync' },
  syncing: { tone: 'info', text: 'Syncing… ~1 min' },
  'out-of-sync': { tone: 'warning', text: 'Out of sync' },
  revoked: { tone: 'negative', text: 'Revoked' },
  unknown: { tone: 'neutral', text: 'Unknown' },
};


export default function CompanyPage() {
  const company = useCompany();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState('');
  const [registry, setRegistry] = useState<Address | null>(null);
  const [selected, setSelected] = useState<Person | null>(null);
  const close = useCallback(() => setSelected(null), []);

  useEffect(() => {
    setRegistry(null);
    setSelected(null);
    companyRegistry(company.account).then((r) => setRegistry(r?.registry ?? null), () => setRegistry(null));
  }, [company.account]);

  const load = () => {
    setPeople(null);
    setError('');
    loadPeople(company.account).then(setPeople, (e) => setError(e instanceof Error ? e.message : String(e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [company.account]);

  return (
    <div className="page">
      <PageHeader title="Company" subtitle="Who your company is on ENS, who acts for it, and the controls to add or remove people." />

      <Card title={company.name} subtitle="Company profile" testId="company-profile"
        actions={<>
          <a className="btn btn-sm" data-testid="ens-explorer" href={ensNameUrl(company.ens)} target="_blank" rel="noreferrer">ENS Explorer</a>
          <a className="btn btn-sm" href={`${config.explorer}/address/${company.account}`} target="_blank" rel="noreferrer">Whitechain explorer</a>
        </>}>
        <dl className="kv">
          <dt>ENS name</dt><dd className="mono" data-testid="company-ens">{company.ens}</dd>
          <dt>Name</dt><dd>{company.name}</dd>
          <dt>Role in the demo</dt><dd><Pill tone="info">{company.role}</Pill></dd>
          <dt>Account on Whitechain</dt><dd><Addr value={company.account} href={`${config.explorer}/address/${company.account}`} /></dd>
          <dt>ENS registry</dt>
          <dd>{registry ? <Addr value={registry} href={registryEventsUrl(registry)} /> : <span className="faint">reading…</span>}</dd>
          <dt>ENS data</dt>
          <dd className="row" data-testid="company-ens-links">
            <a href={ensNameUrl(company.ens)} target="_blank" rel="noreferrer">ENS Explorer</a>
            <span className="faint">·</span>
            <a href={ensRegistryUrl(company.ens)} target="_blank" rel="noreferrer">Registry</a>
            <span className="faint">·</span>
            <a href={ensRolesUrl(company.ens)} target="_blank" rel="noreferrer">Roles in ENS</a>
            {registry && <><span className="faint">·</span><a href={registryEventsUrl(registry)} target="_blank" rel="noreferrer" data-testid="registry-contract-link">Registry contract</a></>}
          </dd>
        </dl>
      </Card>

      <div data-tour="people">
        <Card title="People" subtitle={<>Admin signers of the account and the people who act for it. Select a person for their ENS data. WB Soul shows the real mainnet registry, read live, and the simulated testnet mirror. <a href="/docs/wb-soul/">Check any address against the real registry</a>.</>} flush
          actions={<button className="btn btn-sm" onClick={load}>Refresh</button>}>
          {error ? (
            <div style={{ padding: '0 24px 24px' }}><Notice tone="negative">Couldn&apos;t read the team from Whitechain and ENS ({error}). <button className="btn btn-sm" onClick={load}>Retry</button></Notice></div>
          ) : people && people.length === 0 ? (
            <div style={{ padding: '0 24px 24px' }}><Empty>No people found for this account yet. Add an approver role on the company&apos;s ENS name.</Empty></div>
          ) : (
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr><th>Person</th><th>Roles</th><th>WB Soul</th><th>Whitechain</th></tr></thead>
              <tbody>
                {people === null
                  ? [0, 1, 2].map((i) => <tr key={i}><td><span className="skeleton" style={{ width: 160 }} /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td></tr>)
                  : people.map((p) => (
                    <tr key={p.address} data-testid="person-row" data-address={p.address.toLowerCase()} className="person-row-click"
                      tabIndex={0} role="button" aria-label={`Open ${p.label}`}
                      onClick={(e) => { if (!(e.target as Element).closest('a,button')) setSelected(p); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(p); } }}>
                      <td>
                        <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                          <span className="avatar" aria-hidden="true">{p.label.charAt(0).toUpperCase()}</span>
                          <span><span style={{ fontWeight: 500 }}>{p.label}</span><span className="cell-sub mono">{`${p.address.slice(0, 6)}…${p.address.slice(-4)}`}</span></span>
                        </span>
                      </td>
                      <td><span className="row">{p.roles.length ? p.roles.map((r) => <Pill key={r}>{r}</Pill>) : <span className="faint">none</span>}</span></td>
                      <td><SoulStatus address={p.address} /></td>
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

      <Card title="Add a person" subtitle="Roles are granted on your company's ENS name by an admin, not in this app." testId="add-person">
        <ol className="stack" style={{ gap: 8, paddingLeft: 20, margin: 0 }}>
          <li>The new person sets up an approver passkey and sends you their approver account address.</li>
          <li>An admin opens <a href={ensRolesUrl(company.ens)} target="_blank" rel="noreferrer">Roles in ENS</a> for <span className="mono">{company.ens}</span> and grants the Approver role to that address.</li>
          <li>Whitechain picks the change up when the role cache syncs (84 s measured); the person then shows as In sync above.</li>
        </ol>
        <div className="row" style={{ marginTop: 16 }}>
          <a className="btn" href="/onboard/" data-testid="add-person-onboard">Set up an approver passkey</a>
          <a className="btn" href={ensRolesUrl(company.ens)} target="_blank" rel="noreferrer">Open ENS roles</a>
        </div>
      </Card>

      {!selected && (
        <section className="stack" data-testid="manage-access">
          <div>
            <h2>Manage access</h2>
            <p className="muted" style={{ marginTop: 4 }}>Add a backup signer to your own approver account, or remove someone from the company.</p>
          </div>
          <BackupSigner />
          <RemovePerson key={company.account} initialAccount={company.account} />
        </section>
      )}

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
      {selected && <PersonDrawer person={selected} account={company.account} ens={company.ens} registry={registry} onClose={close} />}
    </div>
  );
}
