'use client';

import { useEffect, useState } from 'react';
import { formatEther, formatUnits, type Hex } from 'viem';
import { type Invoice } from '@/lib/invoice.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';
import { buildInvoiceAuth, invoiceAuthDigest, type InvoiceAuth } from '@/lib/invoice-auth.ts';
import { signInvoiceAuthWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { ethCall, getBlockTimestamp, getReceipt, rpc } from '@/lib/rpc.ts';
import { encodeForward, estimateForwardFee, findInvoicePaidViaL1, sendWithInjectedWallet } from '@/lib/ensgate.ts';
import { appendPayment, loadPasskey } from '@/lib/storage.ts';
import {
  decodeInvoiceDigest, defaultAuthParams, encodeInvoiceDigestCall, encodePayOne, mergeApprovals, parseApprovals,
  relayerBody, serializeApproval, type Approval,
} from '@/lib/payment.ts';

type Loaded = { invoice: Invoice; auth: InvoiceAuth };
type L1 = { data: Hex; gas?: bigint; fee?: bigint; feeError?: string; hash?: Hex; started?: number; fromBlock?: bigint; l2Tx?: Hex; seconds?: number };
type Guard = { status: 'checking' } | { status: 'ok'; digest: Hex } | { status: 'refused'; reason: string };

const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PayPage() {
  const [state, setState] = useState<'loading' | 'invalid' | Loaded>('loading');
  const [guard, setGuard] = useState<Guard>({ status: 'checking' });
  const [mine, setMine] = useState<Approval | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<{ hash: Hex; started: number; seconds?: number; status?: string } | null>(null);
  const [calldata, setCalldata] = useState('');
  const [label, setLabel] = useState('acme');
  const [l1, setL1] = useState<L1 | null>(null);

  useEffect(() => {
    const load = () =>
      decodeInvoiceLink(location.href)
        .then((invoice) => {
          const { nonce, expiry } = defaultAuthParams(invoice);
          setState({ invoice, auth: buildInvoiceAuth(invoice, nonce, expiry) });
        })
        .catch(() => setState('invalid'));
    load();
    addEventListener('hashchange', load);
    return () => removeEventListener('hashchange', load);
  }, []);

  useEffect(() => {
    if (typeof state !== 'object') return;
    const pm = config.paymentModule;
    if (!pm) return setGuard({ status: 'refused', reason: 'PaymentModule address is not configured.' });
    setGuard({ status: 'checking' });
    const local = invoiceAuthDigest(state.auth, { chainId: config.chainId, verifyingContract: pm });
    ethCall(pm, encodeInvoiceDigestCall(state.auth))
      .then((res) => {
        const onchain = decodeInvoiceDigest(res);
        setGuard(onchain.toLowerCase() === local.toLowerCase()
          ? { status: 'ok', digest: local }
          : { status: 'refused', reason: `On-chain digest ${onchain} does not match the invoice shown (${local}).` });
      })
      .catch((e) => setGuard({ status: 'refused', reason: `Could not read the on-chain digest: ${msg(e)}` }));
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
    if (!l1?.started || l1.seconds !== undefined || typeof state !== 'object' || !config.paymentModule) return;
    const pm = config.paymentModule;
    const t = setInterval(async () => {
      try {
        const hit = await findInvoicePaidViaL1(pm, state.auth.account, state.auth.nonce, l1.fromBlock ?? 0n);
        if (hit) setL1({ ...l1, l2Tx: hit.txHash, seconds: (Date.now() - l1.started!) / 1000 });
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [l1, state]);

  if (state === 'loading') return <main>Decrypting invoice…</main>;
  if (state === 'invalid') return <main><h1 data-testid="invalid">Invalid or tampered link</h1></main>;

  const { invoice: i, auth } = state;
  const approvals = (() => {
    try { return mergeApprovals(mine ? [mine] : [], pasted.trim() ? parseApprovals(pasted) : []); } catch { return null; }
  })();

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const onApprove = run(async () => {
    if (guard.status !== 'ok') return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    const signature = await signInvoiceAuthWithPasskey(key.credentialId, guard.digest, key);
    setMine({ approver: key.approverAccount, signature });
  });

  const onPay = run(async () => {
    if (!approvals?.length) throw new Error('No approvals yet.');
    if (!config.relayerUrl) throw new Error('Relayer URL is not configured; use "Copy calldata" or "Send via Ethereum".');
    const started = Date.now();
    const res = await fetch(`${config.relayerUrl}/pay`, {
      signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(relayerBody(auth, approvals)),
    }).catch(() => { throw new Error('Relayer unreachable: use "Send via Ethereum" below, or "Copy calldata".'); });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
    setTx({ hash: body.txHash, started });
  });

  const gate = config.sepolia.ensGate;

  const onPrepareL1 = run(async () => {
    if (!approvals?.length) throw new Error('No approvals yet.');
    if (!gate) throw new Error('EnsGate address is not configured.');
    if (!label.trim()) throw new Error('Enter the company name label.');
    const data = encodeForward(label.trim(), auth, approvals);
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
    const data = encodePayOne(auth, approvals);
    setCalldata(data);
    await navigator.clipboard?.writeText(data).catch(() => undefined);
  });

  return (
    <main>
      <h1>Invoice {i.id}</h1>
      <table>
        <tbody>
          <tr><td>From</td><td>{i.supplierName} ({i.supplierAccount})</td></tr>
          <tr><td>Pay to</td><td>{i.payee}</td></tr>
          <tr><td>Buyer account</td><td>{i.buyerAccount}</td></tr>
          <tr><td>Token</td><td>{i.token}</td></tr>
          <tr><td>Amount</td><td data-testid="amount">{usdt(i.amount)}</td></tr>
          <tr><td>Due</td><td>{new Date(i.dueDate * 1000).toISOString().slice(0, 10)}</td></tr>
          <tr><td>Memo</td><td>{i.memo}</td></tr>
          <tr><td>invoiceHash</td><td data-testid="invoice-hash" style={{ wordBreak: 'break-all' }}>{auth.invoiceHash}</td></tr>
          <tr><td>Approval valid until</td><td>{new Date(Number(auth.expiry) * 1000).toISOString().slice(0, 10)}</td></tr>
        </tbody>
      </table>
      <h2>Lines</h2>
      <table>
        <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead>
        <tbody>
          {i.lines.map((l, n) => (
            <tr key={n}><td>{l.description}</td><td>{l.quantity.toString()}</td><td>{usdt(l.unitPrice)}</td><td>{usdt(l.quantity * l.unitPrice)}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Approve</h2>
      {guard.status === 'checking' && <p data-testid="guard-checking">Checking what you will sign against the contract…</p>}
      {guard.status === 'refused' && <p data-testid="guard-refused" style={{ color: 'crimson' }}>Refusing to sign: {guard.reason}</p>}
      {guard.status === 'ok' && <p data-testid="guard-ok">The contract digest matches this invoice: <code>{guard.digest}</code></p>}
      <button data-testid="approve" onClick={onApprove} disabled={busy || guard.status !== 'ok'}>Approve with Face ID</button>
      {mine && (
        <p>Your approval (send this to the second approver if needed):<br /><code data-testid="my-approval" style={{ wordBreak: 'break-all' }}>{serializeApproval(mine)}</code></p>
      )}
      <p>
        <label>Approvals from other approvers (JSON)<br />
          <textarea data-testid="pasted" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4} cols={80} />
        </label>
      </p>
      {approvals === null && <p style={{ color: 'crimson' }}>Pasted approvals are not valid JSON {'{approver, signature}'}.</p>}
      <p>Approvals collected: <span data-testid="approval-count">{approvals?.length ?? 0}</span></p>

      <h2>Pay</h2>
      <button data-testid="pay" onClick={onPay} disabled={busy || !approvals?.length}>Pay</button>{' '}
      <button data-testid="calldata" onClick={onCopyCalldata} disabled={busy || !approvals?.length}>Copy calldata</button>
      {error && <p data-testid="error" style={{ color: 'crimson' }}>{error}</p>}
      {tx && (
        <p data-testid="tx">
          Transaction <a href={`${config.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{tx.hash}</a>{' '}
          {tx.seconds === undefined ? 'pending…' : `${tx.status} in ${tx.seconds.toFixed(1)} s`}
          {tx.status === 'success' && <> · <a href="/export/">Export for accounting</a></>}
        </p>
      )}

      <h2>Send via Ethereum</h2>
      <p>
        Works with Tazor&apos;s relayer and Whitechain&apos;s sequencer down: the payment goes to EnsGate on Ethereum, which
        checks the approvers&apos; ENS roles and delivers it to Whitechain through the OptimismPortal (about a minute).
      </p>
      <p><label>Company name <input data-testid="label" value={label} onChange={(e) => setLabel(e.target.value)} size={16} />.taz0r.eth</label></p>
      <button data-testid="prepare-l1" onClick={onPrepareL1} disabled={busy || !approvals?.length}>Prepare Ethereum transaction</button>
      {l1 && (
        <div data-testid="l1">
          <p>To EnsGate {gate} on Sepolia. {l1.fee !== undefined
            ? <span data-testid="l1-fee">Estimated fee: {formatEther(l1.fee)} ETH ({l1.gas?.toString()} gas)</span>
            : l1.feeError ? <span data-testid="l1-fee-error">Fee estimate failed: {l1.feeError}</span> : 'Estimating fee…'}</p>
          <p>
            <button data-testid="send-l1" onClick={onSendL1} disabled={busy || !!l1.hash}>Send with your wallet</button>{' '}
            <button data-testid="copy-l1" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: gate, data: l1.data })).catch(() => undefined)}>Copy calldata</button>{' '}
            <button data-testid="watch-l1" onClick={onWatchL1} disabled={busy || !!l1.started}>I sent it myself, watch for delivery</button>
          </p>
          <p>Calldata for any wallet or Etherscan (to {gate}):<br /><code data-testid="l1-data" style={{ wordBreak: 'break-all' }}>{l1.data}</code></p>
          {l1.hash && <p>Ethereum tx <a href={`${config.sepolia.explorer}/tx/${l1.hash}`} target="_blank" rel="noreferrer">{l1.hash}</a></p>}
          {l1.started && (
            <p data-testid="l1-status">{l1.l2Tx
              ? <>Delivered on Whitechain in {l1.seconds?.toFixed(0)} s: <a href={`${config.explorer}/tx/${l1.l2Tx}`} target="_blank" rel="noreferrer">{l1.l2Tx}</a></>
              : 'Waiting for the deposit to reach Whitechain…'}</p>
          )}
        </div>
      )}
      {calldata && (
        <p>Send this calldata to PaymentModule {config.paymentModule ?? '(not configured)'} from any wallet on Whitechain:<br />
          <code data-testid="calldata-out" style={{ wordBreak: 'break-all' }}>{calldata}</code></p>
      )}
    </main>
  );
}
