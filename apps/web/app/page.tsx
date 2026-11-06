'use client';

import { useState } from 'react';
import { TIMINGS } from '@/lib/timings.ts';
import {
  createPasskey, signChallenge, verifyOnChain, isValidResult, type PasskeyPublicKey, type PasskeySignature, type Hex,
} from '@/lib/webauthn';

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
    <tr><td>{label}</td><td data-testid={id} style={{ wordBreak: 'break-all' }}>{value}</td></tr>
  );

  return (
    <main>
      <nav><a href="/onboard/">Onboard</a> · <a href="/team/">Team</a> · <a href="/export/">Export</a> · <a href="/mandates/">Mandates</a> · <a href="/policies/">Policies</a> · <a href="/financing/">Financing</a> · <a href="/settings/">Settings</a></nav>
      <section data-testid="timings">
        <h2>Typical bank vs Tazor</h2>
        <table>
          <thead><tr><th>Action</th><th>Typical bank</th><th>Tazor</th></tr></thead>
          <tbody>
            {TIMINGS.map((t) => (
              <tr key={t.action}>
                <td>{t.action}</td>
                <td>{t.bank}</td>
                <td>
                  {t.tazor}{t.status === 'pending' ? '' : ` (${t.status})`}
                  {t.proof?.map((p) => <span key={p.url}> · <a href={p.url} target="_blank" rel="noreferrer">{p.label}</a></span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <h1>Tazor passkey check</h1>
      <p>Signs with a passkey and verifies on Whitechain Sepolia (P-256 precompile 0x…0100).</p>
      <button data-testid="create" onClick={onCreate} disabled={busy}>Create passkey</button>{' '}
      <button data-testid="sign" onClick={onSign} disabled={busy || !key}>Sign test challenge</button>
      {error && <p data-testid="error" style={{ color: 'crimson' }}>{error}</p>}
      <table>
        <tbody>
          {key && row('x', 'x', key.x)}
          {key && row('y', 'y', key.y)}
          {run && row('hash', 'hash', run.hash)}
          {run && row('r', 'r', run.r)}
          {run && row('s (low-s)', 's', run.s)}
          {run && row('raw s', 'raw-s', run.rawS)}
          {run && row('raw was high-s', 'high-s', String(run.wasHighS))}
          {run && row('precompile', 'result', run.result)}
          {run && row('valid', 'valid', String(run.valid))}
          {key && row('signatures', 'count', String(count))}
        </tbody>
      </table>
    </main>
  );
}
