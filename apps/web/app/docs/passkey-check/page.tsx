'use client';

import { useState } from 'react';
import { Card, Notice } from '../../_ui/index.tsx';
import {
  createPasskey, signChallenge, verifyOnChain, isValidResult, type PasskeyPublicKey, type PasskeySignature, type Hex,
} from '@/lib/webauthn';
import { DocPage, Steps } from '../_doc.tsx';

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

  return (
    <DocPage slug="passkey-check" related={['approver-passkey', 'security-model', 'contracts']}>
      <p>
        This check signs a random challenge with a test passkey on this device and asks Whitechain&apos;s P-256 precompile
        (<code>0x…0100</code>) whether the signature is valid. It is the same verification your approver account uses.
      </p>
      <h2>Run the check</h2>
      <Steps>
        <li>Choose <b>Create test passkey</b>. Test passkeys are separate from your approver passkey.</li>
        <li>Choose <b>Sign test challenge</b> and confirm with your device.</li>
        <li><b>valid</b> shows <code>true</code> when the precompile accepted the signature.</li>
      </Steps>
      <p>
        Passkey signatures come DER-encoded, and about half of them use the &quot;high&quot; form of <code>s</code>. Tazor
        converts every signature to the low form before submitting it; <b>raw was high-s</b> shows whether this one needed it.
      </p>
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
    </DocPage>
  );
}
