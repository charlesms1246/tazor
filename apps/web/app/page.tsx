'use client';

import { useState } from 'react';
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
      <nav><a href="/onboard/">Onboard</a> · <a href="/team/">Team</a></nav>
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
