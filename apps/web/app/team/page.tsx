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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('');
  const [tx, setTx] = useState<{ hash: Hex; started: number; seconds?: number; status?: string; added?: boolean } | null>(null);
  const valid = isAddress(eoa);

  useEffect(() => {
    if (!tx || tx.seconds !== undefined) return;
    const key = loadPasskey();
    const t = setInterval(async () => {
      try {
        const r = await getReceipt(tx.hash);
        if (!r) return;
        const added = key ? decodeIsSigner(await ethCall(key.approverAccount, encodeIsSigner(backupSigner(getAddress(eoa))))) : undefined;
        setTx({ ...tx, seconds: (Date.now() - tx.started) / 1000, status: r.status === '0x1' ? 'success' : 'reverted', added });
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
    <section>
      <h2>Add a backup signer</h2>
      <p>
        A backup signer is an ordinary wallet address that can approve for you if you lose your passkey devices. It is
        added to your approver account as a second signer; either one alone can approve. The transaction is sponsored
        (no WBT needed) within your WB Soul&apos;s daily quota.
      </p>
      <label>
        Backup wallet address{' '}
        <input data-testid="eoa" value={eoa} onChange={(e) => setEoa(e.target.value.trim())} size={44} placeholder="0x…" />
      </label>
      {eoa && !valid && <p style={{ color: 'crimson' }}>Not a valid address.</p>}
      {valid && <p>Backup signer id: <code data-testid="backup-signer">{backupSigner(eoa)}</code></p>}
      <button data-testid="add-backup" onClick={onAdd} disabled={busy || !valid}>Add with Face ID</button>
      {step && <p data-testid="backup-step">{step}</p>}
      {error && <p data-testid="backup-error" style={{ color: 'crimson' }}>{error}</p>}
      {tx && (
        <p data-testid="backup-tx">
          Transaction <a href={`${config.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{tx.hash}</a>{' '}
          {tx.seconds === undefined ? 'pending…' : `${tx.status} in ${tx.seconds.toFixed(1)} s`}
          {tx.added && <strong data-testid="backup-added"> · Backup signer added</strong>}
          {tx.seconds !== undefined && tx.added === false && <strong style={{ color: 'crimson' }}> · not added (the operation reverted inside the account)</strong>}
        </p>
      )}
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
