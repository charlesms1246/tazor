'use client';

import { useState } from 'react';
import { formatUnits, getAddress, isAddress, isHex, parseUnits, type Address, type Hex } from 'viem';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import {
  claimId, decodeClaims, decodeFinancedDigest, decodeListings, decodeOwnerOf, encodeApproveUsdt, encodeBuy, encodeClaims,
  encodeCommit, encodeFinancedDigest, encodeList, encodeListings, encodeOwnerOf, encodeSettle, financedDigest,
  type FinancedInvoice,
} from '@/lib/financing.ts';
import { invoiceHash } from '@/lib/invoice.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';
import { mergeApprovals, parseApprovals, serializeApproval, type Approval } from '@/lib/payment.ts';
import { ethCall } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { sendOnWhitechain } from '@/lib/wallet-wc.ts';

const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ZERO = '0x0000000000000000000000000000000000000000';

type Tx = { to: Address; data: Hex; label: string };

function Txs({ txs, id }: { txs: Tx[]; id: string }) {
  const [hashes, setHashes] = useState<Record<number, Hex>>({});
  const [err, setErr] = useState('');
  return (
    <div data-testid={`${id}-out`}>
      {txs.map((t, i) => (
        <div key={i}>
          <p>{t.label}: to {t.to} on Whitechain Sepolia<br /><code data-testid={`${id}-calldata-${i}`} style={{ wordBreak: 'break-all' }}>{t.data}</code></p>
          <button onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: t.to, data: t.data })).catch(() => undefined)}>Copy calldata</button>{' '}
          <button onClick={() => sendOnWhitechain(t.to, t.data).then((h) => setHashes({ ...hashes, [i]: h }), (e) => setErr(msg(e)))}>Send with your wallet</button>
          {hashes[i] && <> <a href={`${config.explorer}/tx/${hashes[i]}`} target="_blank" rel="noreferrer">{hashes[i]}</a></>}
        </div>
      ))}
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </div>
  );
}

function Commit({ fm }: { fm: Address }) {
  const [link, setLink] = useState('');
  const [f, setF] = useState({ invoiceHash: '', account: '', holder: '', amount: '', due: '' });
  const [prepared, setPrepared] = useState<{ fi: FinancedInvoice; digest: Hex } | null>(null);
  const [mine, setMine] = useState<Approval | null>(null);
  const [pasted, setPasted] = useState('');
  const [out, setOut] = useState<Tx[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  const approvals = (() => {
    try { return mergeApprovals(mine ? [mine] : [], pasted.trim() ? parseApprovals(pasted) : []); } catch { return null; }
  })();

  const onLink = run(async () => {
    const inv = await decodeInvoiceLink(link);
    setF({
      ...f, invoiceHash: invoiceHash(inv), account: inv.buyerAccount, holder: inv.supplierAccount,
      amount: formatUnits(inv.amount, 6), due: new Date(inv.dueDate * 1000).toISOString().slice(0, 16),
    });
  });

  const onPrepare = run(async () => {
    if (!isHex(f.invoiceHash) || f.invoiceHash.length !== 66) throw new Error('invoiceHash must be 32 bytes.');
    if (!isAddress(f.account) || !isAddress(f.holder)) throw new Error('Enter the buyer account and the holder.');
    const due = Math.floor(new Date(f.due).getTime() / 1000);
    if (!Number.isFinite(due) || due * 1000 <= Date.now()) throw new Error('Pick a future due date.');
    const fi: FinancedInvoice = {
      invoiceHash: f.invoiceHash as Hex, account: getAddress(f.account), holder: getAddress(f.holder),
      amount: parseUnits(f.amount || '0', 6), dueDate: BigInt(due), nonce: BigInt(Date.now()),
    };
    const local = financedDigest(fi, { chainId: config.chainId, verifyingContract: fm });
    const onchain = decodeFinancedDigest(await ethCall(fm, encodeFinancedDigest(fi)));
    if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error(`Refusing to sign: contract digest ${onchain} differs from ${local}.`);
    setPrepared({ fi, digest: local });
    setMine(null); setOut(null);
  });

  const onApprove = run(async () => {
    if (!prepared) return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    setMine({ approver: key.approverAccount, signature: await signDigestWithPasskey(key.credentialId, prepared.digest, key) });
  });

  const onCommit = run(async () => {
    if (!prepared || !approvals?.length) throw new Error('No approvals yet.');
    setOut([{ to: fm, data: encodeCommit(prepared.fi, approvals), label: 'commit' }]);
  });

  return (
    <section>
      <h2>1. Commit (buyer approvers)</h2>
      <p><label>Invoice link (optional) <input data-testid="fin-link" value={link} onChange={(e) => setLink(e.target.value)} size={60} /></label>{' '}
        <button onClick={onLink} disabled={busy || !link}>Read link</button></p>
      <p>
        <label>invoiceHash <input data-testid="fin-hash" value={f.invoiceHash} onChange={(e) => setF({ ...f, invoiceHash: e.target.value })} size={68} /></label><br />
        <label>Buyer account <input data-testid="fin-account" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} size={44} /></label><br />
        <label>Holder (gets paid at due date) <input data-testid="fin-holder" value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} size={44} /></label><br />
        <label>Amount (USDT) <input data-testid="fin-amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} size={10} /></label>{' '}
        <label>Due <input data-testid="fin-due" type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
      </p>
      <button data-testid="fin-prepare" onClick={onPrepare} disabled={busy}>Prepare</button>
      {prepared && (
        <>
          <p>Claim id <code data-testid="fin-claim-id" style={{ wordBreak: 'break-all' }}>{claimId(prepared.digest).toString()}</code>; digest matches the contract: <code data-testid="fin-digest">{prepared.digest}</code></p>
          <button data-testid="fin-approve" onClick={onApprove} disabled={busy}>Approve with Face ID</button>
          {mine && <p>Your approval:<br /><code style={{ wordBreak: 'break-all' }}>{serializeApproval(mine)}</code></p>}
          <p><label>Approvals from other approvers (JSON)<br /><textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} cols={80} /></label></p>
          <button data-testid="fin-commit" onClick={onCommit} disabled={busy || !approvals?.length}>Build commit</button>
        </>
      )}
      {error && <p data-testid="fin-error" style={{ color: 'crimson' }}>{error}</p>}
      {out && <Txs txs={out} id="fin-commit" />}
    </section>
  );
}

function Claim({ fm }: { fm: Address }) {
  const [idText, setIdText] = useState('');
  const [view, setView] = useState<{ id: bigint; owner: Address | null; account: Address; due: bigint; amount: bigint; price: bigint } | null>(null);
  const [price, setPrice] = useState('');
  const [out, setOut] = useState<Tx[] | null>(null);
  const [error, setError] = useState('');

  const id = (() => { try { return BigInt(idText.trim()); } catch { return null; } })();
  const onView = async () => {
    setError(''); setOut(null);
    try {
      if (id === null) throw new Error('Enter a claim id.');
      const [account, due, amount] = decodeClaims(await ethCall(fm, encodeClaims(id)));
      const listed = decodeListings(await ethCall(fm, encodeListings(id)));
      const owner = account === ZERO ? null : decodeOwnerOf(await ethCall(fm, encodeOwnerOf(id)));
      setView({ id, owner, account, due, amount, price: listed });
    } catch (e) { setView(null); setError(msg(e)); }
  };
  const due = view ? Number(view.due) * 1000 <= Date.now() : false;

  return (
    <section>
      <h2>2. Claim</h2>
      <p><label>Claim id <input data-testid="claim-id" value={idText} onChange={(e) => setIdText(e.target.value)} size={80} /></label>{' '}
        <button data-testid="claim-view" onClick={onView}>View</button></p>
      {view && (view.account === ZERO
        ? <p data-testid="claim-none">No open claim with this id (never committed, or already settled).</p>
        : (
          <table data-testid="claim">
            <tbody>
              <tr><td>Holder</td><td data-testid="claim-owner">{view.owner}</td></tr>
              <tr><td>Payer account</td><td>{view.account}</td></tr>
              <tr><td>Face value</td><td data-testid="claim-amount">{usdt(view.amount)}</td></tr>
              <tr><td>Due</td><td>{new Date(Number(view.due) * 1000).toISOString()}</td></tr>
              <tr><td>Listed at</td><td data-testid="claim-price">{view.price === 0n ? 'not listed' : usdt(view.price)}</td></tr>
            </tbody>
          </table>
        ))}
      {view && view.account !== ZERO && (
        <p>
          <label>Price (USDT) <input data-testid="list-price" value={price} onChange={(e) => setPrice(e.target.value)} size={10} /></label>{' '}
          <button data-testid="claim-list" onClick={() => setOut([{ to: fm, data: encodeList(view.id, parseUnits(price || '0', 6)), label: 'list (holder)' }])}>List (holder)</button>{' '}
          <button data-testid="claim-buy" disabled={view.price === 0n} onClick={() => setOut([
            { to: configV2.usdt, data: encodeApproveUsdt(fm, view.price), label: 'approve USDT (financier)' },
            { to: fm, data: encodeBuy(view.id), label: 'buy (financier)' },
          ])}>Buy for {view.price === 0n ? '–' : usdt(view.price)}</button>{' '}
          <button data-testid="claim-settle" disabled={!due} onClick={() => setOut([{ to: fm, data: encodeSettle(view.id), label: 'settle (anyone)' }])}>
            {due ? 'Settle (anyone)' : 'Settle (after the due date)'}</button>
        </p>
      )}
      {error && <p data-testid="claim-error" style={{ color: 'crimson' }}>{error}</p>}
      {out && <Txs txs={out} id="claim" />}
    </section>
  );
}

export default function FinancingPage() {
  const fm = configV2.financingModule;
  if (!fm) return <main><h1>Invoice financing</h1><p>FinancingModule address is not configured.</p></main>;
  return (
    <main>
      <h1>Invoice financing</h1>
      <p>
        Buyer approvers commit to pay an invoice on its due date to whoever then holds the claim. The holder can sell
        the claim at a discount to a WB Soul-verified financier; at the due date anyone can settle it from the buyer&apos;s account.
      </p>
      <Commit fm={fm} />
      <Claim fm={fm} />
    </main>
  );
}
