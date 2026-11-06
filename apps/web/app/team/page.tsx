'use client';

import { useState } from 'react';
import { isAddress } from 'viem';
import { backupSigner } from '@/lib/approver-signature.ts';

export default function TeamPage() {
  const [eoa, setEoa] = useState('');
  const valid = isAddress(eoa);
  return (
    <main>
      <h1>Add a backup signer</h1>
      <p>
        A backup signer is an ordinary wallet address that can approve for you if you lose your passkey devices. It is
        added to your approver account as a second signer; either one alone can approve.
      </p>
      <p><strong>Display only:</strong> adding it on-chain needs a passkey-signed user operation, which this page does not send yet.</p>
      <label>
        Backup wallet address{' '}
        <input data-testid="eoa" value={eoa} onChange={(e) => setEoa(e.target.value.trim())} size={44} placeholder="0x…" />
      </label>
      {eoa && !valid && <p style={{ color: 'crimson' }}>Not a valid address.</p>}
      {valid && <p>Backup signer id: <code data-testid="backup-signer">{backupSigner(eoa)}</code></p>}
    </main>
  );
}
