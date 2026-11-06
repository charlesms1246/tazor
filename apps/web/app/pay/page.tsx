'use client';

import { useEffect, useState } from 'react';
import { formatUnits, type Hex } from 'viem';
import { type Invoice } from '@/lib/invoice.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';
import { buildInvoiceAuth, invoiceAuthDigest, type InvoiceAuth } from '@/lib/invoice-auth.ts';
import { signInvoiceAuthWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { ethCall, getReceipt } from '@/lib/rpc.ts';
import { loadPasskey } from '@/lib/storage.ts';
import {
  decodeInvoiceDigest, defaultAuthParams, encodeInvoiceDigestCall, encodePayOne, mergeApprovals, parseApprovals,
  relayerBody, serializeApproval, type Approval,
} from '@/lib/payment.ts';

type Loaded = { invoice: Invoice; auth: InvoiceAuth };
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
        if (r) setTx({ ...tx, seconds: (Date.now() - tx.started) / 1000, status: r.status === '0x1' ? 'success' : 'reverted' });
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [tx]);

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
    if (!config.relayerUrl) throw new Error('Relayer URL is not configured; use "Copy calldata" instead.');
    const started = Date.now();
    const res = await fetch(`${config.relayerUrl}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(relayerBody(auth, approvals)),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
    setTx({ hash: body.txHash, started });
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
        </p>
      )}
      {calldata && (
        <p>Send this calldata to PaymentModule {config.paymentModule ?? '(not configured)'} from any wallet on Whitechain:<br />
          <code data-testid="calldata-out" style={{ wordBreak: 'break-all' }}>{calldata}</code></p>
      )}
    </main>
  );
}
