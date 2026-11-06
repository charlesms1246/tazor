'use client';

import { useEffect, useState } from 'react';
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from 'viem';
import { revocationListAbi } from '@/lib/abi/RevocationList.ts';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { isV2Account } from '@/lib/pay-v2.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { decodeIsRevoked, decodeRevokeDigest, encodeIsRevokedCall, encodeRevokeDigestCall, revokeDigest, revokeRelayerBody, type Revoke } from '@/lib/revoke.ts';
import { ethCall } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { companyByAccount, useCompany } from '@/lib/company.ts';
import { shortAddress } from '@/lib/human.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Field, Notice, Pill } from '../_ui/index.tsx';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Prepared = { list: Address; v2: boolean; r: Revoke; digest: Hex; me: Address };

const companyName = (a: string) => companyByAccount(a)?.name ?? `company ${shortAddress(a)}`;

/** Self-revoke this device's approver for one company (allowed without the admin role). */
export function FreezeDevice() {
  const company = useCompany();
  const [account, setAccount] = useState('');
  // start with the company this device is acting for; it can still be changed
  useEffect(() => { if (company.status !== 'loading' && company.status !== 'error' && company.id) setAccount((a) => a || company.account); }, [company.account, company.id, company.status]);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tx?: Hex; calldata?: { to: Address; data: Hex }; revoked?: boolean } | null>(null);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const onPrepare = run(async () => {
    setResult(null); setPrep(null);
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device: nothing to freeze.');
    if (!isAddress(account)) throw new Error('Enter the company account.');
    const a = getAddress(account);
    const v2 = await isV2Account(a);
    const list = v2 ? configV2.revocationList : config.revocationList;
    if (!list) throw new Error('RevocationList address is not configured.');
    const r: Revoke = { account: a, target: key.approverAccount, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    const local = revokeDigest(r, list, config.chainId);
    const onchain = decodeRevokeDigest(await ethCall(list, encodeRevokeDigestCall(r)));
    if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error("Refusing to sign: the contract doesn't agree with this page about what you would sign. Nothing was changed.");
    setPrep({ list, v2, r, digest: local, me: key.approverAccount });
  });

  const onConfirm = run(async () => {
    if (!prep) return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device.');
    const sig = await signDigestWithPasskey(key.credentialId, prep.digest, key);
    const calldata = { to: prep.list, data: encodeFunctionData({ abi: revocationListAbi, functionName: 'revoke', args: [prep.r.account, prep.me, prep.me, prep.r.deadline, sig] }) };
    const relayerUrl = getRelayerUrl();
    let tx: Hex | undefined;
    if (relayerUrl) {
      const res = await fetch(`${relayerUrl}/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ ...revokeRelayerBody(prep.r, prep.me, sig), ...(prep.v2 ? { list: prep.list } : {}) }),
      }).catch(() => null);
      const body = res ? await res.json().catch(() => ({})) : {};
      if (res?.ok) tx = body.txHash;
      else setError(`Relayer did not submit (${body.error ?? 'unreachable'}); send the calldata below from any wallet.`);
    }
    setResult({ tx, calldata });
    setPrep(null);
  });

  const onCheck = run(async () => {
    if (!isAddress(account)) return;
    const key = loadPasskey();
    if (!key) return;
    const a = getAddress(account);
    const list = (await isV2Account(a)) ? configV2.revocationList : config.revocationList;
    if (!list) return;
    const revoked = decodeIsRevoked(await ethCall(list, encodeIsRevokedCall(a, key.approverAccount)));
    setResult((r) => ({ ...(r ?? {}), revoked }));
  });

  return (
    <div className="settings-row">
      <div>
        <h2>Freeze this device</h2>
        <p>If this phone is lost or compromised, revoke its approver for a company. It takes effect on Whitechain immediately and cannot be undone; an admin has to add a new approver account.</p>
      </div>
      <div className="fields">
        <Field label="Company account" hint={isAddress(account) ? `Freezes this device for ${companyName(account)}.` : 'The company account this device approves for.'}>
          <input className="input mono" data-testid="freeze-account" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="0x…" />
        </Field>
        <div className="row">
          <button className="btn btn-danger" data-testid="freeze-prepare" onClick={onPrepare} disabled={busy}>Freeze…</button>
          <span className="small faint">This device stops approving for that company, permanently.</span>
        </div>
        {prep && (
          <Notice tone="warning">
            <div className="stack" style={{ gap: 12 }} data-testid="freeze-confirm">
              <span>
                This adds your device (<AddrChip value={prep.me} href={`${config.explorer}/address/${prep.me}`} testId="freeze-me" />) to{' '}
                <b>{companyName(prep.r.account)}</b>&apos;s revocation list (<AddrChip value={prep.list} name={prep.v2 ? 'RevocationList v2' : 'RevocationList'} href={`${config.explorer}/address/${prep.list}`} testId="freeze-list" />).
                {' '}From then on this device can&apos;t approve payments for {companyName(prep.r.account)}. This can&apos;t be undone.
              </span>
              <span className="row">
                <button className="btn btn-sm btn-danger" data-testid="freeze-yes" onClick={onConfirm} disabled={busy}>Yes, freeze with passkey</button>
                <button className="btn btn-sm" onClick={() => setPrep(null)}>Cancel</button>
              </span>
            </div>
          </Notice>
        )}
        {error && <Notice tone="negative"><span data-testid="freeze-error">{error}</span></Notice>}
        {result?.tx && <p className="small" data-testid="freeze-tx">✓ Freeze submitted on Whitechain · <a href={`${config.explorer}/tx/${result.tx}`} target="_blank" rel="noreferrer" data-value={result.tx}>View transaction</a></p>}
        {result?.calldata && (
          <details className="well">
            <summary className="small muted">For developers: send it yourself from any wallet</summary>
            <p className="small muted">Send this calldata to {shortAddress(result.calldata.to)} on Whitechain:</p>
            <code className="break small" data-testid="freeze-calldata">{result.calldata.data}</code>
          </details>
        )}
        {result && (
          <div className="row">
            <button className="btn btn-sm" data-testid="freeze-check" onClick={onCheck} disabled={busy}>Check status</button>
            {result.revoked !== undefined && <span data-testid="freeze-status">{result.revoked
              ? <><Pill tone="negative">Revoked</Pill> <span className="small muted">this device can no longer approve for this company.</span></>
              : <Pill>Not revoked yet</Pill>}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
