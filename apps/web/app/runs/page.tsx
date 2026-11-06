'use client';

import { useEffect, useState } from 'react';
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
import { ethCall, getReceipt } from '@/lib/rpc.ts';
import { recordEvent, type EventKind } from '@/lib/events.ts';
import { upsertInbox } from '@/lib/inbox.ts';
import { RUN_STEPS, pendingSteps, shortAddr, subjectOf, useEvents } from '@/lib/story.ts';
import { decodeRunDigest, encodePayRun, encodeRunDigestCall, payRunRelayerBody, runDigest } from '@/lib/runs.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { Addr, Card, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { Timeline } from '../_ui/timeline.tsx';
import '../_invoice/touch.css';
import { loadInvoices, runCandidates } from '@/lib/invoices-store.ts';
import { loadPayments } from '@/lib/storage.ts';
import { partyName } from '@/lib/story.ts';

const amt = (v: bigint) => <>{formatUnits(v, 6)} <span className="faint">USDT</span></>;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX = 50;

type Run = { account: Address; module: Address; v2: boolean; invoices: Invoice[]; auths: InvoiceAuth[]; digest: Hex };

export default function RunsPage() {
  const [links, setLinks] = useState('');
  const [fillNote, setFillNote] = useState('');
  const onFillDevice = () => {
    const c = runCandidates(loadInvoices(), loadPayments());
    if (!c) return setFillNote('No unpaid invoices on this device yet: create some on the Invoices page, or paste links.');
    setLinks(c.links.join('\n'));
    setFillNote(`${c.links.length} unpaid invoice${c.links.length === 1 ? '' : 's'} for ${partyName(c.buyer)} from this device.${c.links.length < 2 ? ' A run needs at least two.' : ''}`);
  };
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<{ line: number; error: string }[]>([]);
  const [mine, setMine] = useState<Approval | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<Hex | null>(null);
  const [calldata, setCalldata] = useState('');
  const events = useEvents(run?.digest.toLowerCase());

  /** Records the same step on the run and on each of its invoices, each title naming its own object. */
  const story = (r: Run, kind: EventKind, what: string, extra: { actor?: string; tx?: string; detail?: string } = {}) => {
    const at = Date.now();
    const runName = `Payment run (${r.invoices.length} invoices)`;
    const chain = extra.tx ? 'whitechain' as const : undefined;
    recordEvent({ subject: r.digest.toLowerCase(), kind, at, title: `${runName} ${what}`, chain, ...extra });
    for (const inv of r.invoices) recordEvent({ subject: subjectOf(inv), kind, at, title: `${inv.id} ${what} in a payment run`, chain, ...extra });
  };

  useEffect(() => {
    if (!run || !tx) return;
    const started = Date.now();
    const t = setInterval(async () => {
      try {
        const r = await getReceipt(tx);
        if (!r) return;
        clearInterval(t);
        if (r.status === '0x1') {
          const secs = ((Date.now() - started) / 1000).toFixed(1);
          story(run, 'paid', `paid in ${secs} s`, { tx, detail: `settled in ${secs} s` });
          upsertInbox({ id: run.digest, status: 'paid' });
        } else {
          story(run, 'failed', 'reverted', { tx, detail: 'transaction reverted' });
        }
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, tx]);

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
    upsertInbox({
      id: local, kind: 'run', title: `Payment run · ${invoices.length} invoices`, href: '/runs/', account,
      counterparty: [...new Set(invoices.map((x) => x.supplierName))].join(', '),
      amount: auths.reduce((s, a) => s + a.amount, 0n).toString(),
      dueDate: Math.min(...invoices.map((x) => x.dueDate)),
    });
  });

  const onApprove = run$(async () => {
    if (!run) return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    setMine({ approver: key.approverAccount, signature: await counterfactualApproval(key, await signDigestWithPasskey(key.credentialId, run.digest, key)) });
    const who = shortAddr(key.approverAccount);
    story(run, 'approved', `approved by ${who}`, { actor: who, detail: 'one passkey signature for the whole run' });
    upsertInbox({ id: run.digest, status: 'approved', approvals: 1 + (pasted.trim() ? (() => { try { return parseApprovals(pasted).length; } catch { return 0; } })() : 0) });
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
    story(run, 'submitted', 'submitted via the relayer', { tx: body.txHash });
  });

  const onCopy = run$(async () => {
    if (!run || !approvals?.length) throw new Error('No approvals yet.');
    const data = encodePayRun(run.account, run.auths, approvals.map((a) => ({ ...a, signature: unwrap6492(a.signature).inner })));
    setCalldata(data);
    await navigator.clipboard?.writeText(data).catch(() => undefined);
  });

  const total = run?.auths.reduce((s, a) => s + a.amount, 0n) ?? 0n;
  const errorNotice = error && <Notice tone="negative" testId="run-error">{error}</Notice>;
  return (
    <div className="page tz-touch">
      <PageHeader title="Payment runs" subtitle="Approve many invoices with one signature; each link is decrypted and checked exactly as on the Pay page." />

      <Card title="Invoices in this run" subtitle="Paste one payment link per line. Every invoice must be paid by the same buyer account.">
        <div className="stack">
          <Field label="Invoice links">
            <textarea data-testid="run-links" className="textarea mono" value={links} onChange={(e) => setLinks(e.target.value)} rows={6} placeholder="https://…/pay/#v1.…" />
          </Field>
          <div className="row">
            <button type="button" data-testid="run-fill-device" className="btn btn-sm" onClick={onFillDevice}>Use unpaid invoices from this device</button>
            {fillNote && <span className="small muted" data-testid="run-fill-note">{fillNote}</span>}
          </div>
          <div className="row">
            <button data-testid="run-prepare" className={run ? 'btn' : 'btn btn-primary'} onClick={onPrepare} disabled={busy}>Check run</button>
          </div>
          {rows.length > 0 && (
            <Notice tone="negative" testId="run-bad">
              <ul style={{ margin: 0, paddingLeft: 18 }}>{rows.map((r) => <li key={r.line}>Link {r.line}: {r.error}</li>)}</ul>
            </Notice>
          )}
          {!run && errorNotice}
        </div>
      </Card>

      {run && (
        <div className="grid-2">
          <Card title="Run" flush subtitle={<>{run.auths.length} invoices from buyer <Addr value={run.account} href={`${config.explorer}/address/${run.account}`} /></>}>
            <div className="table-wrap"><table className="table table-stack" data-testid="run-table">
              <thead><tr><th>Invoice</th><th>Pay to</th><th className="num">Amount</th></tr></thead>
              <tbody>{run.invoices.map((i, n) => (
                <tr key={n}>
                  <td>{i.id}<span className="cell-sub">{i.supplierName}</span></td>
                  <td><Addr value={run.auths[n].payee} /></td>
                  <td className="num">{amt(run.auths[n].amount)}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={2} style={{ fontWeight: 500 }}>Total</td><td className="num" style={{ fontWeight: 500 }}><span data-testid="run-total">{amt(total)}</span></td></tr></tfoot>
            </table></div>
          </Card>

          <Card title="Approve and pay" subtitle={<>{run.v2 ? 'PaymentModuleV2' : 'PaymentModule'} <Addr value={run.module} href={`${config.explorer}/address/${run.module}`} /></>}>
            <div className="stack">
              <Notice tone="positive" testId="run-guard-ok"><span style={{ minWidth: 0 }}>The contract computes the same run digest for these invoices.<span className="mono small digest-line" title={run.digest}>{run.digest}</span></span></Notice>
              <div className="row">
                <button data-testid="run-approve" className={mine ? 'btn' : 'btn btn-primary'} onClick={onApprove} disabled={busy}>Approve run with passkey</button>
                {mine && <Pill tone="positive">Approved on this device</Pill>}
              </div>
              {mine && (
                <div className="well">
                  <p className="small muted">Your approval</p>
                  <code data-testid="run-my-approval" className="mono break">{serializeApproval(mine)}</code>
                </div>
              )}
              <Field label="Approvals from other approvers (JSON)">
                <textarea className="textarea mono" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} />
              </Field>
              <div className="row">
                <button data-testid="run-pay" className={mine ? 'btn btn-primary' : 'btn'} onClick={onPay} disabled={busy || !approvals?.length}>Pay run</button>
                <button data-testid="run-calldata" className="btn" onClick={onCopy} disabled={busy || !approvals?.length}>Copy calldata</button>
              </div>
              {errorNotice}
              {tx && <Notice tone="positive" testId="run-tx"><span>Transaction <a href={`${config.explorer}/tx/${tx}`} target="_blank" rel="noreferrer" className="mono break">{tx}</a></span></Notice>}
              {calldata && (
                <div className="well">
                  <p className="small muted">To <span className="mono">{run.module}</span> on Whitechain</p>
                  <code data-testid="run-calldata-out" className="mono break">{calldata}</code>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {run && (
        <Card title="Activity" subtitle="Recorded on the run and on each of its invoices.">
          <Timeline subject={run.digest.toLowerCase()} pending={pendingSteps(events, RUN_STEPS)} testId="run-timeline" />
        </Card>
      )}
    </div>
  );
}
