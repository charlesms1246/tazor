'use client';

import { Fragment, useEffect, useState } from 'react';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { getRelayerUrl, hasRelayerOverride, normalizeRelayerUrl, setRelayerUrl } from '@/lib/relayer-url.ts';
import { Field, Notice, Pill } from '../_ui/index.tsx';
import { AddrChip } from '../_human/chip.tsx';

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
          : <Notice tone="positive"><span data-testid="relayer-health">Relayer OK. It sends from {health.relayer ? <AddrChip value={health.relayer} href={`${config.explorer}/address/${health.relayer}`} testId="relayer-sender" /> : 'no address'} and pays through {health.paymentModule ? <AddrChip value={health.paymentModule} name="PaymentModule" href={`${config.explorer}/address/${health.paymentModule}`} testId="relayer-payment-module" /> : 'no payment module'}.</span></Notice>)}
      </div>
    </div>
  );
}

/** The contract addresses compiled into this build. */
export function ContractsList() {
  const wc = (a: string) => `${config.explorer}/address/${a}`;
  const sep = (a: string) => `${config.sepolia.explorer}/address/${a}`;
  const rows: [string, string | null, (a: string) => string][] = [
    ['PaymentModule v1', config.paymentModule, wc], ['MandateModule v1', config.mandateModule, wc],
    ['RevocationList v1', config.revocationList, wc], ['ApproverAccountFactory', config.approverAccountFactory, wc],
    ['TazorAccountFactory', config.tazorAccountFactory, wc], ['RoleCache', config.roleCache, wc], ['WB Soul (simulated mirror)', config.wbSoulMirror, wc],
    ['PaymentModuleV2', configV2.paymentModule, wc], ['MandateModuleV2', configV2.mandateModule, wc],
    ['RevocationListV2', configV2.revocationList, wc],
    ['EnsGate (Sepolia)', config.sepolia.ensGate, sep], ['EnsGate v2 (Sepolia)', configV2.ensGateV2, sep],
  ];
  return (
    <div className="settings-row">
      <div>
        <h2>Contracts</h2>
        <p>The contracts this build talks to on Whitechain Sepolia (chain {config.chainId}) and Ethereum Sepolia. Full addresses are on the <a href="/docs/contracts/">Contracts</a> docs page.</p>
      </div>
      <dl className="kv" data-testid="addresses">
        {rows.map(([k, v, href]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd className={v ? '' : 'faint'}>{v ? <AddrChip value={v} href={href(v)} /> : 'not configured'}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
