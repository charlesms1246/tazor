'use client';

import { useEffect, useState } from 'react';
import { formatEther, formatUnits, type Hex } from 'viem';
import { invoiceHash, type Invoice } from '@/lib/invoice.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';
import { buildInvoiceAuth, invoiceAuthDigest, type InvoiceAuth } from '@/lib/invoice-auth.ts';
import { signInvoiceAuthWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { counterfactualApproval, unwrap6492 } from '@/lib/erc6492.ts';
import { ethCall, getBlockTimestamp, getReceipt, rpc } from '@/lib/rpc.ts';
import { encodeForward, estimateForwardFee, findInvoicePaidViaL1, sendWithInjectedWallet } from '@/lib/ensgate.ts';
import { appendPayment, loadPasskey, loadPayments } from '@/lib/storage.ts';
import { verifyCompany, type CompanyVerification } from '@/lib/soul.ts';
import {
  decodeInvoiceDigest, defaultAuthParams, encodeInvoiceDigestCall, encodePayOne, mergeApprovals, parseApprovals,
  relayerBody, serializeApproval, type Approval,
} from '@/lib/payment.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { encodePayAsAgent, encodePayOneV2, isV2Account, v2Digest } from '@/lib/pay-v2.ts';
import { Addr, Card, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { NoLink } from './no-link.tsx';
import { InvoicePaper, paperFromInvoice } from '../_invoice/paper.tsx';

type Loaded = { invoice: Invoice; auth: InvoiceAuth };
type L1 = { data: Hex; gas?: bigint; fee?: bigint; feeError?: string; hash?: Hex; started?: number; fromBlock?: bigint; l2Tx?: Hex; seconds?: number };
type Guard = { status: 'checking' } | { status: 'ok'; digest: Hex } | { status: 'refused'; reason: string };

const amt = (v: bigint) => <>{formatUnits(v, 6)} <span className="faint">USDT</span></>;
const day = (ts: number | bigint) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PayPage() {
  const [state, setState] = useState<'loading' | 'none' | 'invalid' | Loaded>('loading');
  const [guard, setGuard] = useState<Guard>({ status: 'checking' });
  const [mine, setMine] = useState<Approval | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<{ hash: Hex; started: number; seconds?: number; status?: string } | null>(null);
  const [calldata, setCalldata] = useState('');
  const [label, setLabel] = useState('acme');
  const [l1, setL1] = useState<L1 | null>(null);
  const [supplier, setSupplier] = useState<CompanyVerification | 'checking' | 'error'>('checking');
  const [v2, setV2] = useState<boolean | null>(null);
  const [paidBefore, setPaidBefore] = useState<Hex | null>(null);

  useEffect(() => {
    const load = () => (location.hash.length <= 1 ? Promise.resolve(setState('none')) :
      decodeInvoiceLink(location.href)
        .then((invoice) => {
          const { nonce, expiry } = defaultAuthParams(invoice);
          setState({ invoice, auth: buildInvoiceAuth(invoice, nonce, expiry) });
        })
        .catch(() => setState('invalid')));
    load();
    addEventListener('hashchange', load);
    return () => removeEventListener('hashchange', load);
  }, []);

  useEffect(() => {
    if (typeof state !== 'object') return;
    const h = invoiceHash(state.invoice);
    const hit = loadPayments().find((p) => { try { return invoiceHash(p.invoice) === h; } catch { return false; } });
    setPaidBefore((hit?.txHash as Hex | undefined) ?? null);
  }, [state]);

  useEffect(() => {
    if (typeof state !== 'object') return;
    setV2(null);
    isV2Account(state.auth.account).then(setV2);
  }, [state]);

  useEffect(() => {
    if (typeof state !== 'object' || v2 === null) return;
    const pm = v2 ? configV2.paymentModule : config.paymentModule;
    if (!pm) return setGuard({ status: 'refused', reason: 'PaymentModule address is not configured.' });
    setGuard({ status: 'checking' });
    const local = v2 ? v2Digest(state.auth, config.chainId) : invoiceAuthDigest(state.auth, { chainId: config.chainId, verifyingContract: pm });
    ethCall(pm, encodeInvoiceDigestCall(state.auth))
      .then((res) => {
        const onchain = decodeInvoiceDigest(res);
        setGuard(onchain.toLowerCase() === local.toLowerCase()
          ? { status: 'ok', digest: local }
          : { status: 'refused', reason: `On-chain digest ${onchain} does not match the invoice shown (${local}).` });
      })
      .catch((e) => setGuard({ status: 'refused', reason: `Could not read the on-chain digest: ${msg(e)}` }));
  }, [state, v2]);

  useEffect(() => {
    if (typeof state !== 'object') return;
    const { paymentModule, wbSoulMirror } = config;
    if (!paymentModule || !wbSoulMirror) return setSupplier('error');
    setSupplier('checking');
    verifyCompany(state.invoice.supplierAccount, { paymentModule, mirror: wbSoulMirror })
      .then(setSupplier)
      .catch(() => setSupplier('error'));
  }, [state]);

  useEffect(() => {
    if (!tx || tx.seconds !== undefined) return;
    const t = setInterval(async () => {
      try {
        const r = await getReceipt(tx.hash);
        if (!r) return;
        setTx({ ...tx, seconds: (Date.now() - tx.started) / 1000, status: r.status === '0x1' ? 'success' : 'reverted' });
        if (r.status === '0x1' && typeof state === 'object') {
          appendPayment({ invoice: state.invoice, txHash: tx.hash, blockTimestamp: await getBlockTimestamp(r.blockNumber) });
        }
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [tx, state]);

  useEffect(() => {
    const pm = v2 ? configV2.paymentModule : config.paymentModule;
    if (!l1?.started || l1.seconds !== undefined || typeof state !== 'object' || !pm) return;
    const t = setInterval(async () => {
      try {
        const hit = await findInvoicePaidViaL1(pm, state.auth.account, state.auth.nonce, l1.fromBlock ?? 0n);
        if (hit) setL1({ ...l1, l2Tx: hit.txHash, seconds: (Date.now() - l1.started!) / 1000 });
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [l1, state, v2]);

  if (state === 'loading') return <div className="page"><PageHeader title="Invoice" subtitle="Decrypting invoice…" /></div>;
  if (state === 'none') return <NoLink />;
  if (state === 'invalid') {
    return (
      <div className="page">
        <PageHeader title={<span data-testid="invalid">Invalid or tampered link</span>} subtitle="This payment link could not be decrypted. Ask the supplier to send it again." />
      </div>
    );
  }

  const { invoice: i, auth } = state;
  const approvals = (() => {
    try { return mergeApprovals(mine ? [mine] : [], pasted.trim() ? parseApprovals(pasted) : []); } catch { return null; }
  })();
  // contracts read inner signatures; an ERC-6492-wrapped approver must be deployed first (the relayer does this)
  const inner = (approvals ?? []).map((a) => ({ ...a, signature: unwrap6492(a.signature).inner }));
  const pendingDeploys = (approvals ?? []).map((a) => unwrap6492(a.signature)).filter((u) => u.factory);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const onApprove = run(async () => {
    if (guard.status !== 'ok') return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    const signature = await counterfactualApproval(key, await signInvoiceAuthWithPasskey(key.credentialId, guard.digest, key));
    setMine({ approver: key.approverAccount, signature });
  });

  const onPay = run(async () => {
    if (!approvals?.length) throw new Error('No approvals yet.');
    if (v2) throw new Error('The relayer submits v1 payments only; for this v2 company use "Copy calldata" (PaymentModuleV2) or "Send via Ethereum".');
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) throw new Error('Relayer URL is not configured; use "Copy calldata" or "Send via Ethereum".');
    const started = Date.now();
    const res = await fetch(`${relayerUrl}/pay`, {
      signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(relayerBody(auth, approvals)),
    }).catch(() => { throw new Error('Relayer unreachable: use "Send via Ethereum" below, or "Copy calldata".'); });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
    setTx({ hash: body.txHash, started });
  });

  const gate = v2 ? configV2.ensGateV2 : config.sepolia.ensGate;

  const onPrepareL1 = run(async () => {
    if (!approvals?.length) throw new Error('No approvals yet.');
    if (!gate) throw new Error('EnsGate address is not configured.');
    if (!label.trim()) throw new Error('Enter the company name label.');
    const data = encodeForward(label.trim(), auth, inner);
    setL1({ data });
    try {
      const { gas, fee } = await estimateForwardFee(gate, data);
      setL1({ data, gas, fee });
    } catch (e) {
      setL1({ data, feeError: msg(e) });
    }
  });

  const onSendL1 = run(async () => {
    if (!l1 || !gate) return;
    const fromBlock = BigInt(await rpc<Hex>('eth_blockNumber', []));
    const started = Date.now();
    const hash = await sendWithInjectedWallet(gate, l1.data, l1.gas ?? 600_000n);
    setL1({ ...l1, hash, started, fromBlock });
  });

  const onWatchL1 = run(async () => {
    if (!l1) return;
    setL1({ ...l1, started: Date.now(), fromBlock: BigInt(await rpc<Hex>('eth_blockNumber', [])) - 10n });
  });

  const onCopyCalldata = run(async () => {
    if (!approvals?.length) throw new Error('No approvals yet.');
    const data = v2 ? encodePayOneV2(auth, inner) : encodePayOne(auth, inner);
    setCalldata(data);
    await navigator.clipboard?.writeText(data).catch(() => undefined);
  });

  const onPayAsAgent = run(async () => {
    if (!mine) throw new Error('Approve first: the agent signs the same invoice digest.');
    const data = encodePayAsAgent(auth, mine.approver, unwrap6492(mine.signature).inner);
    setCalldata(data);
    await navigator.clipboard?.writeText(data).catch(() => undefined);
  });

  const pm = (v2 ? configV2.paymentModule : config.paymentModule) ?? '(not configured)';
  const explorer = (a: string) => `${config.explorer}/address/${a}`;
  const paidTx = (tx?.status === 'success' ? tx.hash : null) ?? l1?.l2Tx ?? paidBefore;

  return (
    <div className="page">
      <PageHeader
        title={`Invoice ${i.id}`}
        subtitle={<>From {i.supplierName}. Check what you are paying, then approve it with your passkey.</>}
      />
      {v2 && <Notice tone="info" testId="v2-account">v2 company: signed for PaymentModuleV2 <span className="mono break">{configV2.paymentModule}</span> (EIP-712 domain version 2).</Notice>}

      <div className="pay-split">
        <div className="stack">
          <InvoicePaper invoice={paperFromInvoice(i)} status={paidTx ? 'paid' : 'sent'} link={location.href} txHash={paidTx} />
          <p className="small muted">Decrypted from the link on this device; nothing was sent to a server.</p>
        </div>

        <div className="stack paper-sticky">
          <Card title="Approve and pay" subtitle="Approvers sign the invoice digest; anyone can submit the payment.">
            <div className="stack">
              <dl className="kv">
                <dt>From</dt>
                <dd>
                  <span className="stack" style={{ gap: 4 }}>
                    <span>{i.supplierName}</span>
                    <Addr value={i.supplierAccount} href={explorer(i.supplierAccount)} />
                    <span>
                      {supplier === 'checking' ? <Pill testId="supplier-checking">checking…</Pill>
                        : typeof supplier === 'object' && supplier.verified
                          ? <span title={`admin ${supplier.admin}, soul ${supplier.soulId}`}><Pill tone="positive" testId="supplier-verified">✓ Verified by WhiteBIT (simulated on testnet)</Pill></span>
                          : <Pill testId="supplier-unverified">Not verified</Pill>}
                    </span>
                  </span>
                </dd>
                <dt>Amount</dt><dd className="num" data-testid="amount">{amt(i.amount)}</dd>
                <dt>Due</dt><dd className="num">{day(i.dueDate)}</dd>
              </dl>
              {guard.status === 'checking' && <Notice testId="guard-checking">Checking what you will sign against the contract…</Notice>}
              {guard.status === 'refused' && <Notice tone="negative" testId="guard-refused">Refusing to sign: {guard.reason}</Notice>}
              {guard.status === 'ok' && <Notice tone="positive" testId="guard-ok">The contract digest matches this invoice: <span className="mono break">{guard.digest}</span></Notice>}
              <div className="row">
                <button data-testid="approve" className={mine ? 'btn' : 'btn btn-primary'} onClick={onApprove} disabled={busy || guard.status !== 'ok'}>Approve with Face ID</button>
              </div>
              {mine && (
                <div className="well">
                  <p className="small muted">Your approval (send this to the second approver if needed)</p>
                  <code data-testid="my-approval" className="mono break">{serializeApproval(mine)}</code>
                </div>
              )}
              <Field label="Approvals from other approvers (JSON)">
                <textarea data-testid="pasted" className="textarea mono" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4} />
              </Field>
              {approvals === null && <Notice tone="negative">Pasted approvals are not valid JSON {'{approver, signature}'}.</Notice>}
              <p className="muted">Approvals collected: <span className="num" data-testid="approval-count">{approvals?.length ?? 0}</span></p>
              <div className="row">
                <button data-testid="pay" className={mine ? 'btn btn-primary' : 'btn'} onClick={onPay} disabled={busy || !approvals?.length}>Pay</button>
                <button data-testid="calldata" className="btn" onClick={onCopyCalldata} disabled={busy || !approvals?.length}>Copy calldata</button>
                {v2 && <button data-testid="pay-as-agent" className="btn" onClick={onPayAsAgent} disabled={busy || !mine}>Pay as agent (calldata)</button>}
              </div>
              {error && <Notice tone="negative" testId="error">{error}</Notice>}
              {tx && (
                <Notice tone={tx.status === 'reverted' ? 'negative' : tx.status === 'success' ? 'positive' : 'info'} testId="tx">
                  Transaction <a href={`${config.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="mono break">{tx.hash}</a>{' '}
                  {tx.seconds === undefined ? 'pending…' : `${tx.status} in ${tx.seconds.toFixed(1)} s`}
                  {tx.status === 'success' && <> · <a href="/export/">Export for accounting</a></>}
                </Notice>
              )}
              {(calldata || l1) && pendingDeploys.map((u) => (
                <Notice key={u.factoryCalldata} tone="warning" testId="deploy-first">Not deployed yet: first send to the ApproverAccountFactory <span className="mono">{u.factory}</span>: <code className="mono break">{u.factoryCalldata}</code></Notice>
              ))}
              {calldata && <p className="small muted">Calldata ready: see Technical details below.</p>}
            </div>
          </Card>

          <Card title="Send via Ethereum" subtitle="Works with Tazor's relayer and Whitechain's sequencer down.">
            <div className="stack">
              <p className="muted">
                The payment goes to EnsGate on Ethereum, which checks the approvers&apos; ENS roles and delivers it to Whitechain
                through the OptimismPortal (about a minute).
              </p>
              <Field label="Company name">
                <span className="input-affix">
                  <input data-testid="label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
                  <span>.taz0r.eth</span>
                </span>
              </Field>
              <div className="row">
                <button data-testid="prepare-l1" className="btn" onClick={onPrepareL1} disabled={busy || !approvals?.length}>Prepare Ethereum transaction</button>
              </div>
              {l1 && (
                <div data-testid="l1" className="stack">
                  <p className="muted">To EnsGate <span className="mono">{gate}</span> on Sepolia. {l1.fee !== undefined
                    ? <span data-testid="l1-fee">Estimated fee: {formatEther(l1.fee)} ETH ({l1.gas?.toString()} gas)</span>
                    : l1.feeError ? <span data-testid="l1-fee-error">Fee estimate failed: {l1.feeError}</span> : 'Estimating fee…'}</p>
                  <div className="row">
                    <button data-testid="send-l1" className="btn" onClick={onSendL1} disabled={busy || !!l1.hash}>Send with your wallet</button>
                    <button data-testid="copy-l1" className="btn" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: gate, data: l1.data })).catch(() => undefined)}>Copy calldata</button>
                    <button data-testid="watch-l1" className="btn" onClick={onWatchL1} disabled={busy || !!l1.started}>I sent it myself, watch for delivery</button>
                  </div>
                  <p className="small muted">The raw calldata is under Technical details below.</p>
                  {l1.hash && <p>Ethereum tx <a href={`${config.sepolia.explorer}/tx/${l1.hash}`} target="_blank" rel="noreferrer" className="mono break">{l1.hash}</a></p>}
                  {l1.started && (
                    <Notice tone={l1.l2Tx ? 'positive' : 'info'} testId="l1-status">{l1.l2Tx
                      ? <>Delivered on Whitechain in {l1.seconds?.toFixed(0)} s: <a href={`${config.explorer}/tx/${l1.l2Tx}`} target="_blank" rel="noreferrer" className="mono break">{l1.l2Tx}</a></>
                      : 'Waiting for the deposit to reach Whitechain…'}</Notice>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <details className="tech-details" open={!!(calldata || l1)}>
              <summary>Technical details</summary>
              <div className="stack">
                <dl className="kv">
                  <dt>Pay to</dt><dd><Addr value={i.payee} href={explorer(i.payee)} /></dd>
                  <dt>Buyer account</dt><dd><Addr value={i.buyerAccount} href={explorer(i.buyerAccount)} /></dd>
                  <dt>Token</dt><dd><Addr value={i.token} href={explorer(i.token)} /></dd>
                  <dt>invoiceHash</dt><dd><span className="mono break" data-testid="invoice-hash">{auth.invoiceHash}</span></dd>
                  <dt>Approval valid until</dt><dd className="num">{day(auth.expiry)}</dd>
                </dl>
                {calldata && (
                  <div className="well">
                    <p className="small muted">Send this calldata to PaymentModule <span className="mono">{pm}</span> from any wallet on Whitechain</p>
                    <code data-testid="calldata-out" className="mono break">{calldata}</code>
                  </div>
                )}
                {l1 && (
                  <div className="well">
                    <p className="small muted">Calldata for any wallet or Etherscan (to <span className="mono">{gate}</span>)</p>
                    <code data-testid="l1-data" className="mono break">{l1.data}</code>
                  </div>
                )}
              </div>
            </details>
          </Card>
        </div>
      </div>
    </div>
  );
}
