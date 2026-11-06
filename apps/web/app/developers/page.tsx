'use client';

import { useState } from 'react';
import { Card, Notice, PageHeader } from '../_ui/index.tsx';
import {
  createPasskey, signChallenge, verifyOnChain, isValidResult, type PasskeyPublicKey, type PasskeySignature, type Hex,
} from '@/lib/webauthn';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';

type Run = PasskeySignature & { result: Hex; valid: boolean };

export default function Page() {
  const [key, setKey] = useState<PasskeyPublicKey | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const guard = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const onCreate = guard(async () => { setKey(await createPasskey('tazor-test')); setRun(null); setCount(0); });
  const onSign = guard(async () => {
    if (!key) return;
    setRun(null);
    const sig = await signChallenge(key.credentialId, crypto.getRandomValues(new Uint8Array(32)));
    const result = await verifyOnChain(sig.hash, sig.r, sig.s, key.x, key.y);
    setRun({ ...sig, result, valid: isValidResult(result) });
    setCount((c) => c + 1);
  });

  const row = (label: string, id: string, value: string) => (
    <tr key={id}><td className="muted" style={{ width: 180 }}>{label}</td><td data-testid={id} className="mono break">{value}</td></tr>
  );

  const contracts: [string, string | null][] = [
    ['PaymentModule v1', config.paymentModule], ['PaymentModule v2', configV2.paymentModule], ['MandateModule v2', configV2.mandateModule],
    ['FinancingModule', configV2.financingModule], ['RoleCache', config.roleCache], ['ApproverAccountFactory', config.approverAccountFactory],
    ['WB Soul mirror (simulated)', config.wbSoulMirror], ['USDT', configV2.usdt],
  ];

  return (
    <div className="page">
      <PageHeader title="Developers" subtitle="Check this device's passkey against Whitechain's P-256 precompile, and the contracts this build talks to." />
      <Card title="Passkey check" subtitle="Signs a random challenge with a passkey and verifies it on Whitechain Sepolia (precompile 0x…0100)."
        actions={<>
          <button className="btn" data-testid="create" onClick={onCreate} disabled={busy}>Create test passkey</button>
          <button className="btn btn-primary" data-testid="sign" onClick={onSign} disabled={busy || !key}>Sign test challenge</button>
        </>}>
        {error && <Notice tone="negative"><span data-testid="error">{error}</span></Notice>}
        {key ? (
          <div className="table-wrap"><table className="table"><tbody>
            {row('x', 'x', key.x)}
            {row('y', 'y', key.y)}
            {run && row('hash', 'hash', run.hash)}
            {run && row('r', 'r', run.r)}
            {run && row('s (low-s)', 's', run.s)}
            {run && row('raw s', 'raw-s', run.rawS)}
            {run && row('raw was high-s', 'high-s', String(run.wasHighS))}
            {run && row('precompile', 'result', run.result)}
            {run && row('valid', 'valid', String(run.valid))}
            {row('signatures', 'count', String(count))}
          </tbody></table></div>
        ) : <p className="muted">No test passkey yet. Test passkeys made here are separate from your approver passkey.</p>}
      </Card>
      <Card title="Contracts" subtitle="Whitechain Sepolia, chain 1874." flush>
        <div className="table-wrap"><table className="table"><thead><tr><th>Contract</th><th>Address</th></tr></thead><tbody>
          {contracts.map(([name, a]) => (
            <tr key={name}><td>{name}</td><td>{a ? <a className="mono" href={`${config.explorer}/address/${a}`} target="_blank" rel="noreferrer">{a}</a> : <span className="faint">—</span>}</td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  );
}
