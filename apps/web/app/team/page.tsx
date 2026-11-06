'use client';

import { useEffect, useState } from 'react';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { backupSigner, signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import {
  decodeIsRevoked, decodeRevokeDigest, encodeIsRevokedCall, encodeRevokeDigestCall, revokeDigest, revokeRelayerBody,
} from '@/lib/revoke.ts';
import { ethCall, getReceipt } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';

const REVOKE_VALIDITY_S = 600n;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tx = { hash: Hex; started: number; seconds?: number; status?: string; revoked?: boolean };

function RemovePerson() {
  const [account, setAccount] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState('');
  const [tx, setTx] = useState<Tx | null>(null);

  useEffect(() => {
    if (!tx || tx.seconds !== undefined || !config.revocationList) return;
    const rl = config.revocationList;
    const t = setInterval(async () => {
      try {
        const r = await getReceipt(tx.hash);
        if (!r) return;
        const revoked = decodeIsRevoked(await ethCall(rl, encodeIsRevokedCall(getAddress(account), getAddress(target))));
        setTx({ ...tx, seconds: (Date.now() - tx.started) / 1000, status: r.status === '0x1' ? 'success' : 'reverted', revoked });
      } catch { /* keep polling */ }
    }, 500);
    return () => clearInterval(t);
  }, [tx, account, target]);

  const onRemove = async () => {
    setBusy(true);
    setError('');
    setTx(null);
    try {
      const rl = config.revocationList;
      if (!rl) throw new Error('RevocationList address is not configured.');
      if (!config.relayerUrl) throw new Error('Relayer URL is not configured.');
      if (!isAddress(account) || !isAddress(target)) throw new Error('Enter the company account and the person to remove.');
      const key = loadPasskey();
      if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
      const r = { account: getAddress(account), target: getAddress(target), deadline: BigInt(Math.floor(Date.now() / 1000)) + REVOKE_VALIDITY_S };
      const local = revokeDigest(r, rl, config.chainId);
      const onchain = decodeRevokeDigest(await ethCall(rl, encodeRevokeDigestCall(r)));
      if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error(`Refusing to sign: on-chain digest ${onchain} differs from ${local}.`);
      setDigest(local);
      const sig = await signDigestWithPasskey(key.credentialId, local, key);
      const started = Date.now();
      const res = await fetch(`${config.relayerUrl}/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(revokeRelayerBody(r, key.approverAccount as Address, sig)),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
      setTx({ hash: body.txHash, started });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Remove a person</h2>
      <p>Takes effect on Whitechain in about a second: their approvals stop working for this company everywhere.</p>
      <p><label>Company account <input data-testid="revoke-account" value={account} onChange={(e) => setAccount(e.target.value.trim())} size={44} placeholder="0x…" /></label></p>
      <p><label>Person (approver account) <input data-testid="revoke-target" value={target} onChange={(e) => setTarget(e.target.value.trim())} size={44} placeholder="0x…" /></label></p>
      <button data-testid="revoke" onClick={onRemove} disabled={busy}>Remove with Face ID</button>
      {digest && <p>Signed digest (matches the contract): <code data-testid="revoke-digest">{digest}</code></p>}
      {error && <p data-testid="revoke-error" style={{ color: 'crimson' }}>{error}</p>}
      {tx && (
        <p data-testid="revoke-tx">
          Transaction <a href={`${config.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{tx.hash}</a>{' '}
          {tx.seconds === undefined ? 'pending…' : `${tx.status} in ${tx.seconds.toFixed(1)} s`}
          {tx.revoked && <strong data-testid="revoked"> · Revoked</strong>}
        </p>
      )}
    </section>
  );
}

function BackupSigner() {
  const [eoa, setEoa] = useState('');
  const valid = isAddress(eoa);
  return (
    <section>
      <h2>Add a backup signer</h2>
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
    </section>
  );
}

export default function TeamPage() {
  return (
    <main>
      <h1>Team</h1>
      <RemovePerson />
      <BackupSigner />
    </main>
  );
}
