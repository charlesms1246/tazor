'use client';

import { useEffect, useState } from 'react';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { addBackupSigner, backupProofMessage, isBackupSigner } from '@/lib/backup-signer.ts';
import { config } from '@/lib/config.ts';
import { friendlyError } from '@/lib/friendly-errors.ts';
import { plain } from '@/lib/human.ts';
import { getReceipt } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { recordEvent } from '@/lib/events.ts';
import { Notice } from '../_ui/index.tsx';
import { AddrChip } from '../_human/chip.tsx';

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const wallet = () => (globalThis as { ethereum?: Eip1193 }).ethereum;
const msg = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); return friendlyError(m)?.title ?? plain(m); };

/** "Add a backup key": an ordinary wallet the person keeps, proven with a signature, added through a sponsored userOp. */
export function BackupKey({ ready }: { ready: boolean }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [proven, setProven] = useState(false);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const [tx, setTx] = useState<Hex | null>(null);
  const [added, setAdded] = useState<boolean | null>(null);

  useEffect(() => {
    const k = loadPasskey();
    if (!k || !address) return;
    isBackupSigner(k.approverAccount as Address, address).then(setAdded, () => setAdded(null));
  }, [address]);
  useEffect(() => {
    if (!tx || added) return;
    const k = loadPasskey();
    const t = setInterval(async () => {
      const r = await getReceipt(tx).catch(() => null);
      if (!r || !k || !address) return;
      const ok = await isBackupSigner(k.approverAccount as Address, address).catch(() => false);
      setAdded(ok);
      setStep('');
      if (ok) recordEvent({ subject: getAddress(k.approverAccount), kind: 'role-granted', at: Date.now(), title: 'Backup key added to your approver account', detail: 'sponsored by the WB Soul paymaster', tx, chain: 'whitechain' });
      clearInterval(t);
    }, 1500);
    return () => clearInterval(t);
  }, [tx, added, address]);

  const onConnect = async () => {
    setError('');
    const eth = wallet();
    if (!eth) return setError('No browser wallet found on this device. Paste the address of a wallet you keep instead.');
    const k = loadPasskey();
    if (!k) return setError('Create your passkey first.');
    try {
      const [a] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
      const message = backupProofMessage(k.approverAccount, a, new Date());
      setStep('Sign the message in your wallet: it costs nothing and sends no transaction.');
      const sig = (await eth.request({ method: 'personal_sign', params: [message, a] })) as Hex;
      if (!(await verifyMessage({ address: a, message, signature: sig }))) throw new Error('That signature is not from this wallet.');
      setAddress(getAddress(a)); setProven(true); setStep('');
    } catch (e) { setStep(''); setError(msg(e)); }
  };
  const onUseTyped = () => { if (isAddress(typed.trim())) { setAddress(getAddress(typed.trim())); setProven(false); } };
  const onAdd = async () => {
    const k = loadPasskey();
    if (!k || !address) return;
    setError('');
    try { setTx(await addBackupSigner(k, address, setStep)); setStep('Waiting for Whitechain…'); } catch (e) { setStep(''); setError(msg(e)); }
  };

  return (
    <div className="stack" data-testid="backup-key">
      <span style={{ fontWeight: 500 }}>Add a backup key <span className="small muted">(recommended)</span></span>
      <p className="muted">
        Your passkey only works on this website&apos;s address. A backup key is an ordinary wallet you keep. If this website disappears,
        your backup key still approves payments from any other copy of Tazor or from the standalone page.
      </p>
      {!ready ? <p className="small muted">Available once your admin has added you (the step above turns green).</p>
        : added ? (
          <Notice tone="positive" testId="backup-key-added">✓ Backup key added: {address && <AddrChip value={address} href={`${config.explorer}/address/${address}`} />} can approve for you too.{tx && <> <a href={`${config.explorer}/tx/${tx}`} target="_blank" rel="noreferrer" data-value={tx}>View transaction</a></>}</Notice>
        ) : (
          <>
            {!address && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={onConnect} data-testid="backup-key-connect">Connect a wallet and prove it&apos;s yours</button>
                <details style={{ flex: '1 1 100%' }}>
                  <summary className="small muted">No wallet on this device? Enter its address</summary>
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <input className="input mono" style={{ flex: '1 1 240px', minWidth: 0 }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="0x…" data-testid="backup-key-address" />
                    <button type="button" className="btn" onClick={onUseTyped} disabled={!isAddress(typed.trim())} data-testid="backup-key-use">Use this address</button>
                  </div>
                  <p className="small muted">Check it carefully: only that wallet&apos;s owner will be able to approve with it.</p>
                </details>
              </div>
            )}
            {address && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>{proven ? '✓ Wallet proven:' : 'Wallet:'} <AddrChip value={address} href={`${config.explorer}/address/${address}`} testId="backup-key-wallet" /></span>
                <button type="button" className="btn btn-primary" onClick={onAdd} disabled={!!step} data-testid="backup-key-add">Add it with your passkey</button>
                <button type="button" className="btn btn-ghost" onClick={() => { setAddress(null); setProven(false); }} disabled={!!step}>Change</button>
              </div>
            )}
          </>
        )}
      {step && <p className="small muted" role="status" data-testid="backup-key-step">{step}</p>}
      {error && <Notice tone="negative" testId="backup-key-error">{error}</Notice>}
    </div>
  );
}
