'use client';

import { useEffect, useState } from 'react';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { backupSigner, signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import {
  GAS_DEFAULTS, addSignersCallData, applyPaymasterResult, decodeGetUserOpHash, decodeIsSigner, encodeGetNonce,
  encodeGetUserOpHash, encodeIsSigner, relayerRpc, submitUserOp, toRpcUserOp, type UserOp,
} from '@/lib/userop.ts';
import {
  decodeIsRevoked, decodeRevokeDigest, encodeIsRevokedCall, encodeRevokeDigestCall, revokeDigest, revokeRelayerBody,
} from '@/lib/revoke.ts';
import { ethCall, getReceipt, rpc } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { Addr, Card, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { Timeline } from '../_ui/timeline.tsx';
import { recordEvent } from '@/lib/events.ts';
import { labelOf } from '@/lib/people.ts';
import { companyByAccount } from '@/lib/company.ts';

const REVOKE_VALIDITY_S = 600n;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tx = { hash: Hex; started: number; seconds?: number; status?: string; revoked?: boolean };


/** Revoke an approver for a company (admin signs with the passkey); the RevocationList takes effect at once. */
export function RemovePerson({ initialAccount = '', initialTarget = '' }: { initialAccount?: string; initialTarget?: string }) {
  const [account, setAccount] = useState(initialAccount);
  const [target, setTarget] = useState(initialTarget);
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
        if (revoked) {
          const t = getAddress(target);
          const co = companyByAccount(account)?.ens ?? `${account.slice(0, 6)}…${account.slice(-4)}`;
          const me = loadPasskey()?.approverAccount;
          recordEvent({
            subject: t, kind: 'role-revoked', at: Date.now(), title: `${labelOf(t)} removed as approver for ${co}`,
            actor: me ? labelOf(me as Address) : undefined, detail: `${((Date.now() - tx.started) / 1000).toFixed(1)} s to confirm`,
            tx: tx.hash, chain: 'whitechain',
          });
        }
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
      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) throw new Error('Relayer URL is not configured (set one in Settings).');
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
      const res = await fetch(`${relayerUrl}/revoke`, {
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
    <Card title="Remove a person" subtitle="Stops their approvals for this company on Whitechain in about a second, everywhere they sign.">
      <div className="fields">
        <div className="fields-2">
          <Field label="Company account">
            <input className="input mono" data-testid="revoke-account" value={account} onChange={(e) => setAccount(e.target.value.trim())} placeholder="0x…" />
          </Field>
          <Field label="Person (approver account)">
            <input className="input mono" data-testid="revoke-target" value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" />
          </Field>
        </div>
        <div className="row">
          <button className="btn btn-danger" data-testid="revoke" onClick={onRemove} disabled={busy}>Remove with passkey</button>
          <span className="small faint">They can no longer approve payments for this company. Re-adding them needs a new approver account.</span>
        </div>
        {digest && <p className="small muted">Signed digest (matches the contract): <code className="break" data-testid="revoke-digest">{digest}</code></p>}
        {error && <Notice tone="negative"><span data-testid="revoke-error">{error}</span></Notice>}
        {isAddress(target) && (
          <div>
            <div className="small faint" style={{ marginBottom: 8 }}>Activity for {labelOf(getAddress(target))}</div>
            <Timeline subject={getAddress(target)} testId="person-timeline" />
          </div>
        )}
        {tx && (
          <p className="row" data-testid="revoke-tx">
            <span className="muted">Transaction</span>
            <Addr value={tx.hash} href={`${config.explorer}/tx/${tx.hash}`} />
            {tx.seconds === undefined
              ? <Pill>pending</Pill>
              : <Pill tone={tx.status === 'success' ? 'positive' : 'negative'}>{tx.status} in {tx.seconds.toFixed(1)} s</Pill>}
            {tx.revoked && <Pill tone="positive"><span data-testid="revoked"> · Revoked</span></Pill>}
          </p>
        )}
      </div>
    </Card>
  );
}
