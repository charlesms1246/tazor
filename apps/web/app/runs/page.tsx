'use client';

import { useEffect, useState } from 'react';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { signDigestWithPasskey } from '@/lib/approver-signature.ts';
import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { counterfactualApproval, unwrap6492 } from '@/lib/erc6492.ts';
import { buildInvoiceAuth, type InvoiceAuth } from '@/lib/invoice-auth.ts';
import { decodeInvoiceLink } from '@/lib/invoice-link.ts';
import type { Invoice } from '@/lib/invoice.ts';
import { isV2Account } from '@/lib/pay-v2.ts';
import { defaultAuthParams, mergeApprovals, type Approval } from '@/lib/payment.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { RELAYER_WRITE_TIMEOUT_MS, relayerFailure } from '@/lib/relayer-off.ts';
import { ethCall, getReceipt } from '@/lib/rpc.ts';
import { recordEvent, type EventKind } from '@/lib/events.ts';
import { upsertInbox } from '@/lib/inbox.ts';
import { RUN_STEPS, pendingSteps, shortAddr, subjectOf, useEvents } from '@/lib/story.ts';
import { decodeRunDigest, encodePayRun, encodeRunDigestCall, payRunRelayerBody, runDigest } from '@/lib/runs.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { Card, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { Timeline } from '../_ui/timeline.tsx';
import '../_invoice/touch.css';
import { useCompany } from '@/lib/company.ts';
import { useHistory } from '@/lib/chain-history.ts';
import { INBOX_CHANGED, loadInbox, type InboxItem } from '@/lib/inbox.ts';
import { chainPaidMap, companyLedger, type LedgerRow } from '@/lib/ledger.ts';
import { Inr } from '../_invoice/inr.tsx';
import { ApprovalNames, MyApproval } from '../_invoice/approvals-ui.tsx';
import { parseApprovalInput } from '@/lib/approval-code.ts';
import { hasHex } from '@/lib/hex-text.ts';
import { plain } from '@/lib/human.ts';
import { loadInvoices, runCandidates } from '@/lib/invoices-store.ts';
import { loadPayments } from '@/lib/storage.ts';
import { partyName } from '@/lib/story.ts';
import { usdtNumber } from '@/lib/money.ts';
import { AddrChip } from '../_human/chip.tsx';

const amt = (v: bigint) => <>{usdtNumber(v)} <span className="faint">USDT</span></>;
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
  const company = useCompany();
  const chainHistory = useHistory(company.account);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [deviceInvoices, setDeviceInvoices] = useState<ReturnType<typeof loadInvoices>>([]);
  const [devicePayments, setDevicePayments] = useState<ReturnType<typeof loadPayments>>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [vendor, setVendor] = useState('');
  const [due, setDue] = useState<'all' | 'overdue' | 'week'>('all');
  useEffect(() => {
    const sync = () => { setInbox(loadInbox()); setDeviceInvoices(loadInvoices()); setDevicePayments(loadPayments()); };
    sync();
    addEventListener(INBOX_CHANGED, sync);
    return () => removeEventListener(INBOX_CHANGED, sync);
  }, []);
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<{ line: number; error: string }[]>([]);
  const [mine, setMine] = useState<Approval | null>(null);
  const [mineAt, setMineAt] = useState(0);
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

  const pastedParse = (() => {
    try { return { list: parseApprovalInput(pasted, run?.digest), error: '' }; } catch (e) { return { list: null, error: msg(e) }; }
  })();
  const approvals = pastedParse.list === null ? null : mergeApprovals(mine ? [mine] : [], pastedParse.list);
  const run$ = (fn: () => Promise<void>) => async () => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };

  /** Decrypts and checks a run exactly as /pay checks one invoice; refuses the whole run on any problem. */
  const prepareRun = async (lines: string[], min: number): Promise<Run> => {
    setRun(null); setMine(null); setTx(null); setCalldata('');
    if (lines.length < min) throw new Error(min === 1 ? 'Pick at least one bill.' : 'Paste at least two invoice links (one per line).');
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
    const prepared = { account, module, v2, invoices, auths, digest: local };
    setRun(prepared);
    upsertInbox({
      id: local, kind: 'run', title: `Payment run · ${invoices.length} invoices`, href: '/runs/', account,
      counterparty: [...new Set(invoices.map((x) => x.supplierName))].join(', '),
      amount: auths.reduce((s, a) => s + a.amount, 0n).toString(),
      dueDate: Math.min(...invoices.map((x) => x.dueDate)),
    });
    return prepared;
  };
  const onPrepare = run$(async () => { await prepareRun(links.split(/\s+/).map((l) => l.trim()).filter(Boolean), 2); });

  const approveRun = async (run: Run) => {
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    setMine({ approver: key.approverAccount, signature: await counterfactualApproval(key, await signDigestWithPasskey(key.credentialId, run.digest, key)) });
    setMineAt(Date.now());
    const who = shortAddr(key.approverAccount);
    story(run, 'approved', `approved by ${who}`, { actor: who, detail: 'one passkey signature for the whole run' });
    upsertInbox({ id: run.digest, status: 'approved', approvals: 1 + (pastedParse.list?.length ?? 0) });
  };
  const onApprove = run$(async () => { if (run) await approveRun(run); });

  // the bills table: this company's unpaid bills from the shared ledger (device invoices, opened links, chain payments)
  const ledger = companyLedger({ company, invoices: deviceInvoices, payments: devicePayments, inbox, chainPaid: chainPaidMap(chainHistory.events) });
  const unpaid = ledger.bills.filter((r) => r.status !== 'paid' && r.link);
  const vendorOf = (r: LedgerRow) => r.counterpartyName ?? (r.counterparty ? partyName(r.counterparty) : 'Unknown supplier');
  const vendors = [...new Set(unpaid.map(vendorOf))].sort();
  const nowS = Math.floor(Date.now() / 1000);
  const visible = unpaid.filter((r) => (!vendor || vendorOf(r) === vendor)
    && (due === 'all' || (due === 'overdue' ? r.status === 'overdue' : r.dueDate <= nowS + 7 * 86400)));
  const selected = unpaid.filter((r) => picked.has(r.key));
  const selectedTotal = selected.reduce((s, r) => s + r.amount, 0n);
  const allVisiblePicked = visible.length > 0 && visible.every((r) => picked.has(r.key));
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const onApproveSelected = run$(async () => {
    const r = await prepareRun(selected.map((b) => b.link), 1);
    await approveRun(r);
  });

  const onPay = run$(async () => {
    if (!run || !approvals?.length) throw new Error('No approvals yet.');
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) throw new Error('Relayer URL is not configured; use "Copy calldata".');
    const res = await fetch(`${relayerUrl}/payrun`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(RELAYER_WRITE_TIMEOUT_MS),
      body: JSON.stringify(payRunRelayerBody(run.account, run.auths, approvals)),
    }).catch((e) => { throw relayerFailure(e, 'Use "Copy calldata".'); });
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
  const errorNotice = error && (
    <Notice tone="negative" testId="run-error">
      <span className="stack" style={{ gap: 4, minWidth: 0 }}>
        <span>{plain(error)}</span>
        {hasHex(error) && <details className="small error-detail"><summary>For developers</summary>{error}</details>}
      </span>
    </Notice>
  );
  return (
    <div className="page tz-touch">
      <PageHeader title="Payment runs" subtitle="Approve many invoices with one signature; each link is decrypted and checked exactly as on the Pay page." />

      <Card title={`Bills to pay · ${company.name}`} subtitle="Pick the bills to pay together; one passkey approval covers them all." flush testId="run-bills">
        {unpaid.length === 0 ? (
          <div style={{ padding: '0 24px 24px' }}>
            <p className="muted" data-testid="run-bills-empty" style={{ margin: 0 }}>No unpaid bills for {company.name} on this device. Open a supplier&apos;s payment link (Approvals) or add bills by link below.</p>
          </div>
        ) : (
          <>
            <div className="list-bar run-filters">
              <div className="row" style={{ gap: 8, padding: '8px 0' }}>
                <select data-testid="run-filter-vendor" className="select" value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Supplier">
                  <option value="">All suppliers</option>
                  {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select data-testid="run-filter-due" className="select" value={due} onChange={(e) => setDue(e.target.value as typeof due)} aria-label="Due">
                  <option value="all">Any due date</option>
                  <option value="overdue">Overdue</option>
                  <option value="week">Due within 7 days</option>
                </select>
              </div>
            </div>
            <div className="table-wrap"><table className="table table-stack">
              <thead><tr>
                <th style={{ width: 44 }}><input type="checkbox" data-testid="run-select-all" aria-label="Select all shown" checked={allVisiblePicked}
                  onChange={() => setPicked((p) => { const n = new Set(p); for (const r of visible) { if (allVisiblePicked) n.delete(r.key); else n.add(r.key); } return n; })} /></th>
                <th>Supplier</th><th>Invoice</th><th>Due</th><th className="num">Amount</th>
              </tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.key} data-testid="run-bill-row" onClick={() => toggle(r.key)} style={{ cursor: 'pointer' }}>
                    <td><input type="checkbox" data-testid="run-bill-check" aria-label={`Include ${r.id}`} checked={picked.has(r.key)} onChange={() => toggle(r.key)} onClick={(e) => e.stopPropagation()} /></td>
                    <td>{vendorOf(r)}</td>
                    <td>{r.id}</td>
                    <td className="num">{r.dueDate ? new Date(r.dueDate * 1000).toISOString().slice(0, 10) : '—'}{r.status === 'overdue' && <> <Pill tone="negative">Overdue</Pill></>}</td>
                    <td className="num">{amt(r.amount)}<span className="cell-sub"><Inr v={r.amount} /></span></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={4} style={{ fontWeight: 500 }}>Selected: {selected.length} of {unpaid.length}</td>
                <td className="num" style={{ fontWeight: 600 }}><span data-testid="run-bills-total">{usdtNumber(selectedTotal)} USDT</span><span className="cell-sub"><Inr v={selectedTotal} /></span></td></tr></tfoot>
            </table></div>
            <div className="row" style={{ padding: '12px 24px 20px' }}>
              <button type="button" data-testid="run-approve-selected" className={run ? 'btn' : 'btn btn-primary'} onClick={onApproveSelected} disabled={busy || selected.length === 0}>
                {selected.length === 0 ? 'Pick bills to pay' : `Approve ${selected.length} bill${selected.length === 1 ? '' : 's'} · ${usdtNumber(selectedTotal)} USDT with one passkey`}
              </button>
              {!run && error && selected.length > 0 && errorNotice}
            </div>
          </>
        )}
      </Card>

      <Card>
        <details className="tech-details" data-testid="run-add-by-link" open={unpaid.length === 0 || !!links.trim() || undefined}>
          <summary>Add by link</summary>
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>Paste one payment link per line. Every invoice must be paid by the same buyer account.</p>
          <Field label="Invoice links">
            <textarea data-testid="run-links" className="textarea mono" value={links} onChange={(e) => setLinks(e.target.value)} rows={6} placeholder="https://…/pay/#v1.…" />
          </Field>
          <div className="row">
            <button type="button" data-testid="run-fill-device" className="btn btn-sm" onClick={onFillDevice}>Use unpaid invoices from this device</button>
            {fillNote && <span className="small muted" data-testid="run-fill-note">{fillNote}</span>}
          </div>
          <div className="row">
            <button data-testid="run-prepare" className={run || unpaid.length > 0 ? 'btn' : 'btn btn-primary'} onClick={onPrepare} disabled={busy}>Check run</button>
          </div>
          {rows.length > 0 && (
            <Notice tone="negative" testId="run-bad">
              <ul style={{ margin: 0, paddingLeft: 18 }}>{rows.map((r) => <li key={r.line}>Link {r.line}: {r.error}</li>)}</ul>
            </Notice>
          )}
          {!run && !(selected.length > 0) && errorNotice}
        </div>
        </details>
      </Card>

      {run && (
        <div className="grid-2">
          <Card title="Run" flush subtitle={<>{run.auths.length} invoices from <AddrChip value={run.account} name={partyName(run.account)} href={`${config.explorer}/address/${run.account}`} /></>}>
            <div className="table-wrap"><table className="table table-stack" data-testid="run-table">
              <thead><tr><th>Invoice</th><th>Pay to</th><th className="num">Amount</th></tr></thead>
              <tbody>{run.invoices.map((i, n) => (
                <tr key={n}>
                  <td>{i.id}<span className="cell-sub">{i.supplierName}</span></td>
                  <td><AddrChip value={run.auths[n].payee} name={partyName(run.auths[n].payee)} /></td>
                  <td className="num">{amt(run.auths[n].amount)}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={2} style={{ fontWeight: 500 }}>Total</td><td className="num" style={{ fontWeight: 500 }}><span data-testid="run-total">{amt(total)}</span></td></tr></tfoot>
            </table></div>
          </Card>

          <Card title="Approve and pay" subtitle={<>Your passkey signs all {run.invoices.length} invoices at once; {run.v2 ? 'PaymentModuleV2' : 'PaymentModule'} checks the limits.</>}>
            <div className="stack">
              <div data-testid="run-guard-ok" data-digest={run.digest}>
                <Notice tone="positive">✓ The contract agrees on exactly these {run.invoices.length} invoices ({amt(total)} in total).</Notice>
              </div>
              <div className="row">
                <button data-testid="run-approve" className={mine ? 'btn' : 'btn btn-primary'} onClick={onApprove} disabled={busy}>Approve run with passkey</button>
                {mine && <Pill tone="positive">Approved on this device</Pill>}
              </div>
              {mine && <MyApproval approval={mine} at={mineAt || Date.now()} digest={run.digest} what={`the payment run of ${run.invoices.length} invoices`} testId="run-my-approval" shareTestId="run-share-approval" />}
              <Field label="Paste an approval a colleague shared">
                <textarea data-testid="run-pasted" className="textarea" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={2} placeholder="Tazor approval for the payment run…: TZA1.…" />
              </Field>
              {pastedParse.list && <ApprovalNames approvals={pastedParse.list} testId="run-pasted-approvals" />}
              {pastedParse.error && <Notice tone="negative" testId="run-pasted-error">{pastedParse.error}</Notice>}
              <div className="row">
                <button data-testid="run-pay" className={mine ? 'btn btn-primary' : 'btn'} onClick={onPay} disabled={busy || !approvals?.length}>Pay run</button>
                <button data-testid="run-calldata" className="btn" onClick={onCopy} disabled={busy || !approvals?.length}>Copy calldata</button>
              </div>
              {errorNotice}
              {tx && <div data-testid="run-tx" data-tx={tx}><Notice tone="positive">Payment run sent · <a href={`${config.explorer}/tx/${tx}`} target="_blank" rel="noreferrer">View transaction</a></Notice></div>}
              {calldata && <p className="small muted">Calldata copied. It is also under For developers below.</p>}
              <details className="tech-details" data-testid="run-for-developers">
                <summary>For developers</summary>
                <dl className="kv">
                  <dt>Run digest</dt><dd><span className="mono break">{run.digest}</span></dd>
                  <dt>Module</dt><dd><span className="mono break">{run.module}</span></dd>
                </dl>
                {calldata && (
                  <div className="well">
                    <p className="small muted">payRun calldata for {run.v2 ? 'PaymentModuleV2' : 'PaymentModule'} on Whitechain</p>
                    <code data-testid="run-calldata-out" className="mono break">{calldata}</code>
                  </div>
                )}
              </details>
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
