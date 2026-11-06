'use client';

import { useEffect, useState } from 'react';
import { createPasskey } from '@/lib/webauthn.ts';
import { predictApproverAccount } from '@/lib/approver.ts';
import { config } from '@/lib/config.ts';
import { loadPasskey, savePasskey, type StoredPasskey } from '@/lib/storage.ts';

export default function OnboardPage() {
  const [stored, setStored] = useState<StoredPasskey | null>(null);
  const [signer, setSigner] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      setNote(savePasskey(record) ? 'Saved on this device.' : 'Could not save on this device; copy the values below.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Become an approver</h1>
      <p data-testid="wb-label">Verified by WhiteBIT (simulated on testnet)</p>
      <p>
        Your passkey stays in your device keychain. Your approver account address is derived from its public key
        and is deployed later by the relayer.
      </p>
      <button data-testid="create" onClick={onCreate} disabled={busy}>Create passkey</button>
      {error && <p data-testid="error" style={{ color: 'crimson' }}>{error}</p>}
      {note && <p>{note}</p>}
      {stored && (
        <table>
          <tbody>
            <tr><td>Approver account (predicted)</td><td data-testid="approver-account">{stored.approverAccount}</td></tr>
            {signer && <tr><td>Signer id</td><td data-testid="signer" style={{ wordBreak: 'break-all' }}>{signer}</td></tr>}
            <tr><td>Passkey x</td><td style={{ wordBreak: 'break-all' }}>{stored.x}</td></tr>
            <tr><td>Passkey y</td><td style={{ wordBreak: 'break-all' }}>{stored.y}</td></tr>
          </tbody>
        </table>
      )}
    </main>
  );
}
