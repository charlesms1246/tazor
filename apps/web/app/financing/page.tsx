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
import { Card, CopyButton, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { NameChip, TechDetails } from '../_readable/index.tsx';
import { dayText, shortRef, usdtText } from '@/lib/readable.ts';
import { Timeline } from '../_ui/timeline.tsx';
import { recordEvent } from '@/lib/events.ts';
import { usdt2dp } from '@/lib/export.ts';

const usdt = usdtText;
const Amount = ({ v }: { v: bigint }) => <><span className="num">{usdtText(v).replace(' USDT', '')}</span> <span className="faint">USDT</span></>;
/** "Claim on INV-20261106-AB12 · 0.40 USDT due 13 Nov · #a1b2c3" */
const claimTitle = (invoice: string | null, amount: bigint, due: bigint, id: bigint) =>
  `Claim on ${invoice ?? 'this invoice'} · ${usdt(amount)} due ${dayText(due)} · ${shortRef(id)}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ZERO = '0x0000000000000000000000000000000000000000';

type Tx = { to: Address; data: Hex; label: string };

function Txs({ txs, id, onSent }: { txs: Tx[]; id: string; onSent?: (t: Tx, hash: Hex) => void }) {
  const [hashes, setHashes] = useState<Record<number, Hex>>({});
  const [err, setErr] = useState('');
  return (
    <div className="stack" data-testid={`${id}-out`}>
      {txs.map((t, i) => (
        <div key={i} className="well stack">
          <p className="small"><span style={{ fontWeight: 500 }}>{t.label}</span>: ready to send on Whitechain Sepolia</p>
          <TechDetails>
            <p className="small muted">To <span className="mono break">{t.to}</span>:</p>
            <code className="break small" data-testid={`${id}-calldata-${i}`}>{t.data}</code>
          </TechDetails>
          <div className="row">
            <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: t.to, data: t.data })).catch(() => undefined)}>Copy calldata</button>
            <button className="btn btn-sm" onClick={() => sendOnWhitechain(t.to, t.data).then((h) => { setHashes({ ...hashes, [i]: h }); onSent?.(t, h); }, (e) => setErr(msg(e)))}>Send with your wallet</button>
            {hashes[i] && <a href={`${config.explorer}/tx/${hashes[i]}`} target="_blank" rel="noreferrer" data-value={hashes[i]}>View transaction ↗</a>}
          </div>
        </div>
      ))}
      {err && <Notice tone="negative">{err}</Notice>}
    </div>
  );
}

function Commit({ fm }: { fm: Address }) {
  const [link, setLink] = useState('');
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
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
    setInvoiceId(inv.id);
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
    if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error('Refusing to sign: the contract describes a different claim than this page.');
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

  const primary = !prepared ? 'prepare' : !approvals?.length ? 'approve' : 'commit';

  return (
    <Card title="1. Commit" subtitle="Buyer approvers commit to pay this invoice on its due date to whoever then holds the claim.">
      <div className="fields">
        <Field label="Invoice link" hint="Optional: fills in the fields below from a Tazor invoice link.">
          <div className="input-group">
            <input className="input" data-testid="fin-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://taz0r.eth.limo/pay/#v1…" />
            <button className="btn" onClick={onLink} disabled={busy || !link}>Read link</button>
          </div>
        </Field>
        <Field label="Invoice hash">
          <input className="input mono" data-testid="fin-hash" value={f.invoiceHash} onChange={(e) => setF({ ...f, invoiceHash: e.target.value })} placeholder="0x…" />
        </Field>
        <div className="fields-2">
          <Field label="Buyer account">
            <input className="input mono" data-testid="fin-account" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} placeholder="0x…" />
          </Field>
          <Field label="Holder" hint="Gets paid at the due date.">
            <input className="input mono" data-testid="fin-holder" value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} placeholder="0x…" />
          </Field>
          <Field label="Amount">
            <div className="input-affix">
              <input className="input num" style={{ textAlign: 'right' }} inputMode="decimal" data-testid="fin-amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" />
              <span>USDT</span>
            </div>
          </Field>
          <Field label="Due">
            <input className="input" data-testid="fin-due" type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
          </Field>
        </div>
        <div><button className={`btn${primary === 'prepare' ? ' btn-primary' : ''}`} data-testid="fin-prepare" onClick={onPrepare} disabled={busy}>Prepare</button></div>
        {prepared && (
          <div className="well stack">
            <p className="small muted" data-testid="fin-summary" data-value={claimId(prepared.digest).toString()}>
              ✓ The contract agrees: {claimTitle(invoiceId, prepared.fi.amount, prepared.fi.dueDate, claimId(prepared.digest))}, paid to <NameChip address={prepared.fi.holder} link={false} />.
            </p>
            <div><button className={`btn${primary === 'approve' ? ' btn-primary' : ''}`} data-testid="fin-approve" onClick={onApprove} disabled={busy}>Approve with passkey</button></div>
            {mine && <p className="small row" style={{ gap: 6 }}>Your approval is ready. If a second approver is needed, send them your approval: <CopyButton value={serializeApproval(mine)} label="Copy approval" /></p>}
            <TechDetails>
              <dl className="kv">
                <dt>Claim id</dt><dd><code className="break small" data-testid="fin-claim-id">{claimId(prepared.digest).toString()}</code></dd>
                <dt>Digest</dt><dd><code className="break small" data-testid="fin-digest">{prepared.digest}</code></dd>
                <dt>Invoice hash</dt><dd><code className="break small">{prepared.fi.invoiceHash}</code></dd>
                <dt>Nonce</dt><dd className="mono">{prepared.fi.nonce.toString()}</dd>
              </dl>
              {mine && <><p className="small muted">Your approval (JSON)</p><code className="break small">{serializeApproval(mine)}</code></>}
            </TechDetails>
            <Field label="Approvals from other approvers" hint="Paste the JSON a second approver sends you, if needed.">
              <textarea className="textarea mono" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} />
            </Field>
            <div><button className={`btn${primary === 'commit' ? ' btn-primary' : ''}`} data-testid="fin-commit" onClick={onCommit} disabled={busy || !approvals?.length}>Build commit</button></div>
          </div>
        )}
        {error && <Notice tone="negative"><span data-testid="fin-error">{error}</span></Notice>}
        {out && <Txs txs={out} id="fin-commit" />}
      </div>
    </Card>
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
  const onSent = (t: Tx, hash: Hex) => {
    if (!view) return;
    const subject = `claim:${view.id.toString()}`;
    if (t.label.startsWith('buy')) {
      recordEvent({ subject, kind: 'financed', at: Date.now(), title: `Invoice claim ${shortRef(view.id)} bought by a financier for ${usdt2dp(view.price)} USDT`, tx: hash, chain: 'whitechain' });
    } else if (t.label.startsWith('settle')) {
      recordEvent({ subject, kind: 'settled', at: Date.now(), title: `Invoice claim ${shortRef(view.id)} settled: ${usdt2dp(view.amount)} USDT paid to the holder`, tx: hash, chain: 'whitechain' });
    }
  };

  return (
    <Card title="2. Claim" subtitle="Find a claim, list it for sale, buy it, or settle it on the due date.">
      <div className="fields">
        <Field label="Claim id">
          <div className="input-group">
            <input className="input mono" data-testid="claim-id" value={idText} onChange={(e) => setIdText(e.target.value)} />
            <button className="btn" data-testid="claim-view" onClick={onView}>View</button>
          </div>
        </Field>
        {view && (view.account === ZERO
          ? <div className="empty" data-testid="claim-none">No open claim with this id (never committed, or already settled).</div>
          : (
            <dl className="kv" data-testid="claim">
              <dt>Claim</dt><dd>{claimTitle(null, view.amount, view.due, view.id)}</dd>
              <dt>Holder</dt><dd>{view.owner ? <NameChip address={view.owner} testId="claim-owner" /> : <span className="faint" data-testid="claim-owner">none</span>}</dd>
              <dt>Payer</dt><dd><NameChip address={view.account} /></dd>
              <dt>Face value</dt><dd data-testid="claim-amount"><Amount v={view.amount} /></dd>
              <dt>Due</dt><dd className="num">{dayText(view.due)} {due && <Pill tone="warning">due</Pill>}</dd>
              <dt>Listed at</dt><dd data-testid="claim-price">{view.price === 0n ? <span className="faint">not listed</span> : <Amount v={view.price} />}</dd>
            </dl>
          ))}
        {view && view.account !== ZERO && (
          <div className="stack">
            <Field label="Sale price">
              <div className="input-affix" style={{ maxWidth: 220 }}>
                <input className="input num" style={{ textAlign: 'right' }} inputMode="decimal" data-testid="list-price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
                <span>USDT</span>
              </div>
            </Field>
            <div className="row">
              <button className="btn" data-testid="claim-list" onClick={() => setOut([{ to: fm, data: encodeList(view.id, parseUnits(price || '0', 6)), label: 'list (holder)' }])}>List (holder)</button>
              <button className="btn" data-testid="claim-buy" disabled={view.price === 0n} onClick={() => setOut([
                { to: configV2.usdt, data: encodeApproveUsdt(fm, view.price), label: 'approve USDT (financier)' },
                { to: fm, data: encodeBuy(view.id), label: 'buy (financier)' },
              ])}>Buy for {view.price === 0n ? '–' : usdt(view.price)}</button>
              <button className="btn" data-testid="claim-settle" disabled={!due} onClick={() => setOut([{ to: fm, data: encodeSettle(view.id), label: 'settle (anyone)' }])}>
                {due ? 'Settle (anyone)' : 'Settle (after the due date)'}</button>
            </div>
          </div>
        )}
        {error && <Notice tone="negative"><span data-testid="claim-error">{error}</span></Notice>}
        {out && <Txs txs={out} id="claim" onSent={onSent} />}
        {view && view.account !== ZERO && (
          <div>
            <div className="small faint" style={{ marginBottom: 8 }}>Activity for this claim</div>
            <Timeline subject={`claim:${view.id.toString()}`} testId="claim-timeline" />
          </div>
        )}
      </div>
    </Card>
  );
}

export default function FinancingPage() {
  const fm = configV2.financingModule;
  const header = <PageHeader title="Financing" subtitle="Get paid early: sell an approved invoice to a verified financier at a discount (verification simulated on testnet)." />;
  if (!fm) return <div className="page">{header}<Notice tone="negative">FinancingModule address is not configured for this build.</Notice></div>;
  return (
    <div className="page">
      {header}
      <Commit fm={fm} />
      <Claim fm={fm} />
    </div>
  );
}
