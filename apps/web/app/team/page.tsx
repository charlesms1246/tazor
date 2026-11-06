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
          <button className="btn btn-danger" data-testid="revoke" onClick={onRemove} disabled={busy}>Remove with Face ID</button>
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

function BackupSigner() {
  const [eoa, setEoa] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('');
  const [tx, setTx] = useState<{ hash: Hex; started: number; seconds?: number; status?: string; added?: boolean } | null>(null);
  const valid = isAddress(eoa);
  const [me, setMe] = useState<Address | null>(null);
  useEffect(() => { const k = loadPasskey(); if (k) setMe(getAddress(k.approverAccount)); }, []);

  useEffect(() => {
    if (!tx || tx.seconds !== undefined) return;
    const key = loadPasskey();
    const t = setInterval(async () => {
      try {
        const r = await getReceipt(tx.hash);
        if (!r) return;
        const added = key ? decodeIsSigner(await ethCall(key.approverAccount, encodeIsSigner(backupSigner(getAddress(eoa))))) : undefined;
        setTx({ ...tx, seconds: (Date.now() - tx.started) / 1000, status: r.status === '0x1' ? 'success' : 'reverted', added });
        if (added && key) {
          const who = getAddress(key.approverAccount);
          const b = getAddress(eoa);
          recordEvent({
            subject: who, kind: 'role-granted', at: Date.now(), title: `Backup signer ${b.slice(0, 6)}…${b.slice(-4)} added to ${labelOf(who)}`,
            actor: labelOf(who), detail: 'sponsored by the WB Soul paymaster', tx: tx.hash, chain: 'whitechain',
          });
        }
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [tx, eoa]);

  const onAdd = async () => {
    setBusy(true); setError(''); setTx(null);
    try {
      const relayerUrl = getRelayerUrl();
      if (!relayerUrl) throw new Error('Relayer URL is not configured (set one in Settings).');
      const ep = config.entryPoint;
      if (!ep) throw new Error('EntryPoint address is not configured.');
      if (!valid) throw new Error('Enter a valid wallet address.');
      const key = loadPasskey();
      if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
      const sender = key.approverAccount as Address;
      const signer = backupSigner(getAddress(eoa));
      setStep('Checking your approver account…');
      if (((await rpc<Hex>('eth_getCode', [sender, 'latest'])) ?? '0x') === '0x') throw new Error('Your approver account is not deployed yet (finish onboarding first).');
      if (decodeIsSigner(await ethCall(sender, encodeIsSigner(signer)))) throw new Error('This wallet is already a backup signer.');
      const [nonceHex, gasPriceHex] = await Promise.all([ethCall(ep, encodeGetNonce(sender)), rpc<Hex>('eth_gasPrice', [])]);
      const gasPrice = BigInt(gasPriceHex);
      let op: UserOp = {
        sender, nonce: BigInt(nonceHex), callData: addSignersCallData(sender, [signer]),
        callGasLimit: GAS_DEFAULTS.callGasLimit, verificationGasLimit: GAS_DEFAULTS.verificationGasLimit,
        preVerificationGas: GAS_DEFAULTS.preVerificationGas, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice,
        paymasterVerificationGasLimit: GAS_DEFAULTS.paymasterVerificationGasLimit, paymasterPostOpGasLimit: GAS_DEFAULTS.paymasterPostOpGasLimit,
        signature: '0x',
      };
      const chainId = `0x${config.chainId.toString(16)}`;
      setStep('Asking the sponsor (WB Soul quota)…');
      op = applyPaymasterResult(op, await relayerRpc(relayerUrl, 'pm_getPaymasterStubData', [toRpcUserOp(op), ep, chainId, {}]));
      op = applyPaymasterResult(op, await relayerRpc(relayerUrl, 'pm_getPaymasterData', [toRpcUserOp(op), ep, chainId, {}]));
      setStep('Approve with Face ID…');
      const userOpHash = decodeGetUserOpHash(await ethCall(ep, encodeGetUserOpHash(op)));
      op = { ...op, signature: await signDigestWithPasskey(key.credentialId, userOpHash, key) };
      setStep('Submitting…');
      const started = Date.now();
      setTx({ hash: await submitUserOp(relayerUrl, op), started });
      setStep('');
    } catch (e) {
      setError(msg(e)); setStep('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add a backup signer" subtitle="An ordinary wallet that can approve for you if you lose your passkey devices. Either one alone can approve.">
      <div className="fields">
        <Field label="Backup wallet address" hint="Sponsored within your WB Soul's daily quota, so no WBT is needed.">
          <input className="input mono" data-testid="eoa" value={eoa} onChange={(e) => setEoa(e.target.value.trim())} placeholder="0x…" />
        </Field>
        {eoa && !valid && <Notice tone="negative">Not a valid address.</Notice>}
        {valid && <p className="small muted">Backup signer id: <code className="break" data-testid="backup-signer">{backupSigner(eoa)}</code></p>}
        <div className="row">
          <button className="btn btn-primary" data-testid="add-backup" onClick={onAdd} disabled={busy || !valid}>Add with Face ID</button>
          {step && <span className="small muted" data-testid="backup-step">{step}</span>}
        </div>
        {error && <Notice tone="negative"><span data-testid="backup-error">{error}</span></Notice>}
        {me && (
          <div>
            <div className="small faint" style={{ marginBottom: 8 }}>Activity for {labelOf(me)}</div>
            <Timeline subject={me} testId="backup-timeline" />
          </div>
        )}
        {tx && (
          <p className="row" data-testid="backup-tx">
            <span className="muted">Transaction</span>
            <a className="mono" href={`${config.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{`${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`}</a>
            {tx.seconds === undefined
              ? <Pill>pending</Pill>
              : <Pill tone={tx.status === 'success' ? 'positive' : 'negative'}>{tx.status} in {tx.seconds.toFixed(1)} s</Pill>}
            {tx.added && <Pill tone="positive"><span data-testid="backup-added"> · Backup signer added</span></Pill>}
            {tx.seconds !== undefined && tx.added === false && <Pill tone="negative">not added: the operation reverted inside the account</Pill>}
          </p>
        )}
      </div>
    </Card>
  );
}

export default function TeamPage() {
  return (
    <div className="page">
      <PageHeader title="Team" subtitle="Who can approve for your company, and how to recover if a device is lost." />
      <BackupSigner />
      <RemovePerson />
    </div>
  );
}
