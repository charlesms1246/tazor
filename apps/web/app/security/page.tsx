'use client';

import { useEffect, useState } from 'react';
import { config } from '@/lib/config.ts';
import { useCompany } from '@/lib/company.ts';
import { checkHealth, type Health } from '@/lib/health.ts';
import { EVENTS_CHANGED, recentEvents, type TimelineEvent } from '@/lib/events.ts';
import { companyRegistry, loadPeople, type Person } from '@/lib/people.ts';
import { ensApproverState, mirrorLabel, type EnsMirrorState } from '@/lib/ens-mirror.ts';
import { FreezeDevice } from '../settings/freeze.tsx';
import { Card, Empty, PageHeader, Pill } from '../_ui/index.tsx';
import { HEALTH_KEYS, healthRows } from './rows.ts';
import { ContractsList, RelayerSettings } from './relayer-settings.tsx';
import './security.css';

const MIRROR_TONE: Record<EnsMirrorState, 'positive' | 'warning' | 'neutral'> = { mirrored: 'positive', 'still-on-ens': 'warning', unknown: 'neutral' };


export default function SecurityPage() {
  const company = useCompany();
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const [revokedPeople, setRevokedPeople] = useState<Person[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  const refresh = () => {
    setChecking(true);
    checkHealth().then(setHealth).finally(() => setChecking(false));
  };
  useEffect(refresh, []);

  useEffect(() => {
    loadPeople(company.account).then((p) => setRevokedPeople(p.filter((x) => x.whitechain === 'revoked')), () => setRevokedPeople([]));
  }, [company.account]);

  useEffect(() => {
    const sync = () => setEvents(recentEvents(200).filter((e) => e.kind === 'role-revoked').slice(0, 10));
    sync();
    globalThis.addEventListener(EVENTS_CHANGED, sync);
    return () => globalThis.removeEventListener(EVENTS_CHANGED, sync);
  }, []);

  // Whether each removed person is also gone from the company's ENS name (the hosted mirror, or an admin by hand).
  const [mirror, setMirror] = useState<Record<string, EnsMirrorState>>({});
  const targets = [...new Set([...revokedPeople.map((p) => p.address), ...events.map((e) => e.subject)].map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const targetKey = targets.join(',');
  useEffect(() => {
    if (!targets.length) return;
    let live = true;
    companyRegistry(company.account).then(async (r) => {
      const out: Record<string, EnsMirrorState> = {};
      for (const t of targets) out[t] = r ? await ensApproverState(r.registry, t) : 'unknown';
      if (live) setMirror(out);
    }, () => {});
    return () => { live = false; };
  }, [company.account, targetKey]);
  const mirrorPill = (a: string) => {
    const st = mirror[a.toLowerCase()];
    return st ? <Pill tone={MIRROR_TONE[st]} testId="revocation-mirror">{mirrorLabel(st)}</Pill> : null;
  };

  const rows = health ? healthRows(health) : null;
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="page">
      <PageHeader title="Security & settings" subtitle="Live health of everything a payment depends on, the relayer this device uses, recent removals, and the controls for a lost device." />

      <div data-tour="health">
        <Card title="System health" subtitle={health ? `Checked at ${time(health.checkedAt)} from this device.` : 'Checking from this device…'} flush
          actions={<button className="btn btn-sm" data-testid="health-refresh" onClick={refresh} disabled={checking}>Refresh</button>}>
          <div className="table-wrap"><table className="table table-stack health-table">
            <thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {rows === null
                ? HEALTH_KEYS.map((k) => <tr key={k}><td><span className="skeleton" /></td><td><span className="skeleton" style={{ minWidth: 50 }} /></td><td><span className="skeleton" style={{ width: 200 }} /></td></tr>)
                : rows.map((r) => (
                  <tr key={r.key} data-testid="health-row">
                    <td style={{ fontWeight: 500 }}>{r.name}</td>
                    <td><Pill tone={r.tone} dot testId={`health-${r.key}`}>{r.status}</Pill></td>
                    <td className="muted break">{r.detail}</td>
                  </tr>
                ))}
            </tbody>
          </table></div>
        </Card>
      </div>

      <div data-tour="fallback">
      <Card title="If our servers go down">
        <p className="muted">
          A signed payment doesn&apos;t need Tazor: anyone can submit it, and if the relayer or the sequencer stops it, it can be
          sent through Ethereum and still lands on Whitechain. <a href="/docs/censorship-resistance/">How the fallback works</a>
        </p>
      </Card>
      </div>

      <Card testId="settings">
        <RelayerSettings onChange={refresh} />
        <ContractsList />
      </Card>

      <Card title="Recent revocations" subtitle={`Removed approvers for ${company.ens}, and removals made from this device.`}>
        {revokedPeople.length === 0 && events.length === 0 ? <Empty>No revocations yet. Removing someone on Company stops their approvals in seconds.</Empty> : (
          <div className="stack" style={{ gap: 10 }}>
            {revokedPeople.map((p) => (
              <div key={p.address} className="spread revocation-row" data-testid="revoked-person">
                <span><span style={{ fontWeight: 500 }}>{p.label}</span><span className="cell-sub mono">{p.address}</span></span>
                <span className="row" style={{ gap: 6 }}><Pill tone="negative">Revoked on Whitechain</Pill>{mirrorPill(p.address)}</span>
              </div>
            ))}
            {events.map((e) => (
              <div key={`${e.subject}-${e.at}`} className="spread revocation-row" data-testid="revocation-event">
                <span><span style={{ fontWeight: 500 }}>{e.title}</span><span className="cell-sub">{new Date(e.at).toLocaleString()}{e.actor && <> · by {e.actor}</>}</span></span>
                <span className="row" style={{ gap: 6 }}>
                  {mirrorPill(e.subject)}
                  {e.tx && <a className="small" href={`${config.explorer}/tx/${e.tx}`} target="_blank" rel="noreferrer">Whitechain tx</a>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Lost device" subtitle="Only if this device is lost or compromised. This can't be undone.">
        <FreezeDevice />
      </Card>
    </div>
  );
}
