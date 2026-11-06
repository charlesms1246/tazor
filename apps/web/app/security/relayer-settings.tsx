'use client';

import { Fragment, useEffect, useState } from 'react';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { getRelayerUrl, hasRelayerOverride, normalizeRelayerUrl, setRelayerUrl } from '@/lib/relayer-url.ts';
import { Field, Notice, Pill } from '../_ui/index.tsx';

type RelayerHealth = { relayer: string | null; paymentModule: string | null } | { error: string };

/** Choose the relayer this device uses (an override kept on this device), and test it. */
export function RelayerSettings({ onChange }: { onChange?: () => void }) {
  const [current, setCurrent] = useState('');
  const [override, setOverride] = useState(false);
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [health, setHealth] = useState<RelayerHealth | null>(null);

  const refresh = () => {
    const u = getRelayerUrl();
    setCurrent(u);
    setOverride(hasRelayerOverride());
    setInput(u);
  };
  useEffect(refresh, []);

  const onSave = () => {
    setHealth(null);
    if (!setRelayerUrl(input)) return setNote('Not saved: use https://… (or http://localhost for a local relayer).');
    setNote('Saved on this device.');
    refresh();
    onChange?.();
  };
  const onClear = () => {
    setHealth(null);
    setRelayerUrl(null);
    setNote('Cleared: using the default for this build.');
    refresh();
    onChange?.();
  };
  const onTest = async () => {
    const url = normalizeRelayerUrl(input) ?? (input === current ? current : null);
    if (!url) return setHealth({ error: 'Enter a valid relayer URL first.' });
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
      setHealth({ relayer: body.relayer ?? null, paymentModule: body.paymentModule ?? null });
    } catch (e) {
      setHealth({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const noteBad = note.startsWith('Not saved');

  return (
    <div className="settings-row">
      <div>
        <h2>Relayer</h2>
        <p>Optional. &quot;Copy calldata&quot; and &quot;Send via Ethereum&quot; work without one; a relayer only saves you sending the transaction yourself.</p>
      </div>
      <div className="fields">
        <p data-testid="relayer-current" className="row">
          <span className="muted">Using:</span> <span className="mono break">{current || 'none'}</span> {override ? <Pill tone="info">(set on this device)</Pill> : <Pill>(default for this build)</Pill>}
        </p>
        <Field label="Relayer URL" hint="https://… or http://localhost for a local relayer.">
          <input className="input mono" data-testid="relayer-url" value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://relayer.example" />
        </Field>
        <div className="row">
          <button className="btn btn-primary" data-testid="relayer-save" onClick={onSave}>Save</button>
          <button className="btn" data-testid="relayer-test" onClick={onTest}>Test</button>
          <button className="btn btn-ghost" data-testid="relayer-clear" onClick={onClear}>Clear</button>
        </div>
        {note && <Notice tone={noteBad ? 'negative' : 'positive'}><span data-testid="relayer-note">{note}</span></Notice>}
        {health && ('error' in health
          ? <Notice tone="negative"><span data-testid="relayer-health">Relayer check failed: {health.error}</span></Notice>
          : <Notice tone="positive"><span data-testid="relayer-health">Relayer OK: sender <span className="mono break">{health.relayer ?? 'none'}</span>, PaymentModule <span className="mono break">{health.paymentModule ?? 'none'}</span></span></Notice>)}
      </div>
    </div>
  );
}

/** The contract addresses compiled into this build. */
export function ContractsList() {
  const rows: [string, string | null][] = [
    ['Chain', `${config.chainId} (${config.rpcUrl})`],
    ['PaymentModule (v1)', config.paymentModule], ['MandateModule (v1)', config.mandateModule],
    ['RevocationList (v1)', config.revocationList], ['ApproverAccountFactory', config.approverAccountFactory],
    ['TazorAccountFactory', config.tazorAccountFactory], ['RoleCache', config.roleCache], ['WB Soul (simulated mirror)', config.wbSoulMirror],
    ['PaymentModuleV2', configV2.paymentModule], ['MandateModuleV2', configV2.mandateModule],
    ['FinancingModule', configV2.financingModule], ['RevocationListV2', configV2.revocationList],
    ['EnsGate (Sepolia)', config.sepolia.ensGate], ['EnsGate v2 (Sepolia)', configV2.ensGateV2],
  ];
  return (
    <div className="settings-row">
      <div>
        <h2>Contracts</h2>
        <p>Whitechain Sepolia and Ethereum Sepolia addresses compiled into this build.</p>
      </div>
      <dl className="kv" data-testid="addresses">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd className={v ? 'mono' : 'faint'}>{v ?? 'not configured'}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
