'use client';

import { useEffect, useState } from 'react';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { getRelayerUrl, hasRelayerOverride, normalizeRelayerUrl, setRelayerUrl } from '@/lib/relayer-url.ts';
import { FreezeDevice } from './freeze.tsx';

type Health = { relayer: string | null; paymentModule: string | null } | { error: string };

export default function SettingsPage() {
  const [current, setCurrent] = useState('');
  const [override, setOverride] = useState(false);
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [health, setHealth] = useState<Health | null>(null);

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
  };
  const onClear = () => {
    setHealth(null);
    setRelayerUrl(null);
    setNote('Cleared: using the default for this build.');
    refresh();
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
    <main>
      <h1>Settings</h1>
      <p>A relayer is optional: &quot;Copy calldata&quot; and &quot;Send via Ethereum&quot; work without one.</p>
      <h2>Relayer</h2>
      <p data-testid="relayer-current">Using: {current || 'none'} {override ? '(set on this device)' : '(default for this build)'}</p>
      <p>
        <label>Relayer URL <input data-testid="relayer-url" value={input} onChange={(e) => setInput(e.target.value)} size={50} placeholder="https://relayer.example" /></label>{' '}
        <button data-testid="relayer-save" onClick={onSave}>Save</button>{' '}
        <button data-testid="relayer-clear" onClick={onClear}>Clear</button>{' '}
        <button data-testid="relayer-test" onClick={onTest}>Test</button>
      </p>
      {note && <p data-testid="relayer-note">{note}</p>}
      {health && ('error' in health
        ? <p data-testid="relayer-health" style={{ color: 'crimson' }}>Relayer check failed: {health.error}</p>
        : <p data-testid="relayer-health">Relayer OK: sender {health.relayer ?? 'none'}, PaymentModule {health.paymentModule ?? 'none'}</p>)}
      <FreezeDevice />
      <h2>Contracts</h2>
      <table data-testid="addresses">
        <tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v ?? 'not configured'}</td></tr>)}</tbody>
      </table>
    </main>
  );
}
