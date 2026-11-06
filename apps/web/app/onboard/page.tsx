'use client';

import { useEffect, useState } from 'react';
import { createPasskey } from '@/lib/webauthn.ts';
import { predictApproverAccount } from '@/lib/approver.ts';
import { config } from '@/lib/config.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { loadPasskey, savePasskey, type StoredPasskey } from '@/lib/storage.ts';
import { Addr, Card, Notice, PageHeader, Pill } from '../_ui/index.tsx';

export default function OnboardPage() {
  const [stored, setStored] = useState<StoredPasskey | null>(null);
  const [signer, setSigner] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deploy, setDeploy] = useState<{ txHash: string | null } | null>(null);

  useEffect(() => setStored(loadPasskey()), []);

  const onCreate = async () => {
    setBusy(true);
    setError('');
    try {
      if (!config.approverAccountFactory) throw new Error('ApproverAccountFactory address is not configured');
      const key = await createPasskey('tazor-approver');
      const p = await predictApproverAccount(config.approverAccountFactory, key.x, key.y);
      const record = { credentialId: key.credentialId, x: key.x, y: key.y, verifier: p.verifier, approverAccount: p.account };
      setStored(record);
      setSigner(p.signer);
      const saved = savePasskey(record) ? 'Saved on this device.' : 'Could not save on this device; copy the values below.';
      setNote(saved);
      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) return setNote(`${saved} No relayer configured: anyone can deploy this account later with createAccount([signer id]).`);
      const res = await fetch(`${relayerUrl}/approver`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signer: p.signer }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
      if (body.account.toLowerCase() !== p.account.toLowerCase()) throw new Error('relayer returned a different account address');
      setDeploy({ txHash: body.txHash });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const created = !!stored;
  const deployed = !!deploy;
  return (
    <div className="page">
      <PageHeader
        title="Approver onboarding"
        subtitle="Create a passkey on this device; your approver account is derived from it and deployed for you."
      />

      <Card>
        <div style={{ paddingBottom: 12 }}>
          <Pill tone="info" testId="wb-label">Verified by WhiteBIT (simulated on testnet)</Pill>
        </div>
        <div className="steps">
          <div className="step" data-done={created}>
            <span className="step-n">1</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Create a passkey</span>
              <p className="muted">Your passkey stays in your device keychain. Face ID or your device PIN unlocks it whenever you approve.</p>
              <div className="row">
                <button data-testid="create" className="btn btn-primary" onClick={onCreate} disabled={busy}>Create passkey</button>
              </div>
              {error && <Notice tone="negative" testId="error">{error}</Notice>}
              {note && <Notice>{note}</Notice>}
            </div>
          </div>

          <div className="step" data-done={created}>
            <span className="step-n">2</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Your approver account</span>
              {!stored ? (
                <p className="muted">Appears here after you create the passkey: its address is computed from the passkey&apos;s public key.</p>
              ) : (
                <dl className="kv">
                  <dt>Approver account (predicted)</dt>
                  <dd><Addr value={stored.approverAccount} href={`${config.explorer}/address/${stored.approverAccount}`} full testId="approver-account" /></dd>
                  {signer && <><dt>Signer id</dt><dd><span className="mono break" data-testid="signer">{signer}</span></dd></>}
                  <dt>Passkey x</dt><dd><span className="mono break">{stored.x}</span></dd>
                  <dt>Passkey y</dt><dd><span className="mono break">{stored.y}</span></dd>
                </dl>
              )}
            </div>
          </div>

          <div className="step" data-done={deployed}>
            <span className="step-n">3</span>
            <div className="stack">
              <span style={{ fontWeight: 500 }}>Deployed by the relayer</span>
              {deploy ? (
                <p data-testid="deploy">
                  {deploy.txHash
                    ? <a href={`${config.explorer}/tx/${deploy.txHash}`} target="_blank" rel="noreferrer" className="mono break">{deploy.txHash}</a>
                    : 'already deployed'}
                </p>
              ) : (
                <p className="muted">The relayer deploys your account on Whitechain. Without one, anyone can deploy it later with createAccount([signer id]).</p>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
