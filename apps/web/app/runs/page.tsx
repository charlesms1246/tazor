'use client';

import { useState } from 'react';
import { formatUnits, isAddressEqual, type Address, type Hex } from 'viem';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { counterfactualApproval, unwrap6492 } from '@/lib/erc6492.ts';
import { buildInvoiceAuth, type InvoiceAuth } from '@/lib/invoice-auth.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';
import type { Invoice } from '@/lib/invoice.ts';
import { isV2Account } from '@/lib/pay-v2.ts';
import { defaultAuthParams, mergeApprovals, parseApprovals, serializeApproval, type Approval } from '@/lib/payment.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { ethCall } from '@/lib/rpc.ts';
import { decodeRunDigest, encodePayRun, encodeRunDigestCall, payRunRelayerBody, runDigest } from '@/lib/runs.ts';
import { loadPasskey } from '@/lib/storage.ts';

const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX = 50;

type Run = { account: Address; module: Address; v2: boolean; invoices: Invoice[]; auths: InvoiceAuth[]; digest: Hex };

export default function RunsPage() {
  const [links, setLinks] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<{ line: number; error: string }[]>([]);
  const [mine, setMine] = useState<Approval | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<Hex | null>(null);
  const [calldata, setCalldata] = useState('');

  const approvals = (() => {
    try { return mergeApprovals(mine ? [mine] : [], pasted.trim() ? parseApprovals(pasted) : []); } catch { return null; }
  })();
  const run$ = (fn: () => Promise<void>) => async () => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  const onPrepare = run$(async () => {
    setRun(null); setMine(null); setTx(null); setCalldata('');
    const lines = links.split(/\s+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Paste at least two invoice links (one per line).');
    if (lines.length > MAX) throw new Error(`At most ${MAX} invoices per run.`);
    const invoices: Invoice[] = [];
    const bad: { line: number; error: string }[] = [];
    for (const [i, l] of lines.entries()) {
      try { invoices.push(await decodeInvoiceLink(l)); } catch { bad.push({ line: i + 1, error: 'invalid or tampered link' }); }
    }
    const auths: InvoiceAuth[] = [];
    for (const [i, inv] of invoices.entries()) {
      try {
        const { nonce, expiry } = defaultAuthParams(inv);
        auths.push(buildInvoiceAuth(inv, nonce, expiry));
      } catch (e) { bad.push({ line: i + 1, error: msg(e) }); }
    }
    setRows(bad);
    if (bad.length) throw new Error('Fix the invalid links first; the run is refused as a whole.');
    const account = auths[0].account;
    if (!auths.every((a) => isAddressEqual(a.account, account))) throw new Error('All invoices in a run must be paid by the same buyer account.');
    if (new Set(auths.map((a) => a.nonce)).size !== auths.length) throw new Error('The same invoice appears twice.');
    const v2 = await isV2Account(account);
    const module = v2 ? configV2.paymentModule : config.paymentModule;
    if (!module) throw new Error('PaymentModule address is not configured.');
    const local = runDigest(auths, { chainId: config.chainId, verifyingContract: module, version: v2 ? '2' : '1' });
    const onchain = decodeRunDigest(await ethCall(module, encodeRunDigestCall(auths)));
    if (onchain.toLowerCase() !== local.toLowerCase()) throw new Error(`Refusing to sign: on-chain run digest ${onchain} does not match the invoices shown (${local}).`);
    setRun({ account, module, v2, invoices, auths, digest: local });
  });

  const onApprove = run$(async () => {
    if (!run) return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    setMine({ approver: key.approverAccount, signature: await counterfactualApproval(key, await signDigestWithPasskey(key.credentialId, run.digest, key)) });
  });

  const onPay = run$(async () => {
    if (!run || !approvals?.length) throw new Error('No approvals yet.');
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) throw new Error('Relayer URL is not configured; use "Copy calldata".');
    const res = await fetch(`${relayerUrl}/payrun`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify(payRunRelayerBody(run.account, run.auths, approvals)),
    }).catch(() => { throw new Error('Relayer unreachable: use "Copy calldata".'); });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
    setTx(body.txHash);
  });

  const onCopy = run$(async () => {
    if (!run || !approvals?.length) throw new Error('No approvals yet.');
    const data = encodePayRun(run.account, run.auths, approvals.map((a) => ({ ...a, signature: unwrap6492(a.signature).inner })));
    setCalldata(data);
    await navigator.clipboard?.writeText(data).catch(() => undefined);
  });

  const total = run?.auths.reduce((s, a) => s + a.amount, 0n) ?? 0n;
  return (
    <main>
      <h1>Payment run</h1>
      <p>Approve many invoices with one signature. Each link is decrypted and checked exactly as on the Pay page.</p>
      <p><label>Invoice links (one per line)<br /><textarea data-testid="run-links" value={links} onChange={(e) => setLinks(e.target.value)} rows={6} cols={90} /></label></p>
      <button data-testid="run-prepare" onClick={onPrepare} disabled={busy}>Check run</button>
      {rows.length > 0 && <ul data-testid="run-bad">{rows.map((r) => <li key={r.line}>Link {r.line}: {r.error}</li>)}</ul>}
      {run && (
        <>
          <table data-testid="run-table">
            <thead><tr><th>Invoice</th><th>Supplier</th><th>Pay to</th><th>Amount</th></tr></thead>
            <tbody>{run.invoices.map((i, n) => (
              <tr key={n}><td>{i.id}</td><td>{i.supplierName}</td><td>{run.auths[n].payee}</td><td>{usdt(run.auths[n].amount)}</td></tr>
            ))}</tbody>
          </table>
          <p>Buyer {run.account} · {run.auths.length} invoices · total <strong data-testid="run-total">{usdt(total)}</strong> · {run.v2 ? 'PaymentModuleV2' : 'PaymentModule'} {run.module}</p>
          <p data-testid="run-guard-ok">The contract run digest matches these invoices: <code>{run.digest}</code></p>
          <button data-testid="run-approve" onClick={onApprove} disabled={busy}>Approve run with Face ID</button>
          {mine && <p>Your approval:<br /><code data-testid="run-my-approval" style={{ wordBreak: 'break-all' }}>{serializeApproval(mine)}</code></p>}
          <p><label>Approvals from other approvers (JSON)<br /><textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} cols={80} /></label></p>
          <button data-testid="run-pay" onClick={onPay} disabled={busy || !approvals?.length}>Pay run</button>{' '}
          <button data-testid="run-calldata" onClick={onCopy} disabled={busy || !approvals?.length}>Copy calldata</button>
        </>
      )}
      {error && <p data-testid="run-error" style={{ color: 'crimson' }}>{error}</p>}
      {tx && <p data-testid="run-tx">Transaction <a href={`${config.explorer}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a></p>}
      {calldata && run && <p>To {run.module} on Whitechain:<br /><code data-testid="run-calldata-out" style={{ wordBreak: 'break-all' }}>{calldata}</code></p>}
    </main>
  );
}
