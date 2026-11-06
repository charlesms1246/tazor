'use client';

import { useEffect, useRef, useState } from 'react';
import { isCompanyAccount, useCompanies } from '@/lib/company.ts';
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
  decodeInvoiceDigest, defaultAuthParams, encodeInvoiceDigestCall, encodePayOne, mergeApprovals,
  relayerBody, type Approval,
} from '@/lib/payment.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { encodePayAsAgent, encodePayOneV2, isV2Account, v2Digest } from '@/lib/pay-v2.ts';
import { Card, Field, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import { Redirect } from '../_redirect/redirect.tsx';
import { InvoicePaper, issuedFromId, paperFromInvoice } from '../_invoice/paper.tsx';
import { HistoryTimeline } from '../_invoice/history.tsx';
import { useSubjectHistory } from '@/lib/chain-history.ts';
import { eventsFor, recordEvent, type TimelineEvent } from '@/lib/events.ts';
import { loadInbox, upsertInbox } from '@/lib/inbox.ts';
import { INVOICE_STEPS, inboxForInvoice, recordOpened, shortAddr, subjectOf } from '@/lib/story.ts';
import '../_invoice/touch.css';
import { ApprovalNames, MyApproval } from '../_invoice/approvals-ui.tsx';
import { parseApprovalInput } from '@/lib/approval-code.ts';
import { hasHex } from '@/lib/hex-text.ts';
import { plain } from '@/lib/human.ts';
import { printInvoice } from '../_invoice/paper.tsx';
import { toast, Toasts } from '../_invoice/toast.tsx';
import { friendlyError } from '@/lib/friendly-errors.ts';
import { elapsed } from '@/lib/events.ts';
import { partyName } from '@/lib/story.ts';
import { usdtNumber } from '@/lib/money.ts';
import { AddrChip } from '../_human/chip.tsx';

type Loaded = { invoice: Invoice; auth: InvoiceAuth };
type L1 = { data: Hex; gas?: bigint; fee?: bigint; feeError?: string; hash?: Hex; started?: number; fromBlock?: bigint; l2Tx?: Hex; seconds?: number };
type Guard = { status: 'checking' } | { status: 'ok'; digest: Hex } | { status: 'refused'; reason: string };

const amt = (v: bigint) => <>{usdtNumber(v)} <span className="faint">USDT</span></>;
const day = (ts: number | bigint) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PayPage() {
  const [state, setState] = useState<'loading' | 'none' | 'invalid' | Loaded>('loading');
  const [guard, setGuard] = useState<Guard>({ status: 'checking' });
  const [mine, setMine] = useState<Approval | null>(null);
  const [mineAt, setMineAt] = useState(0);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<{ hash: Hex; started: number; seconds?: number; status?: string } | null>(null);
  const [calldata, setCalldata] = useState('');
  const [label, setLabel] = useState('');
  const labelTouched = useRef(false);
  const companies = useCompanies();
  const [l1, setL1] = useState<L1 | null>(null);
  const [supplier, setSupplier] = useState<CompanyVerification | 'checking' | 'error'>('checking');
  const [v2, setV2] = useState<boolean | null>(null);
  const [paidBefore, setPaidBefore] = useState<Hex | null>(null);
  const subject = typeof state === 'object' ? subjectOf(state.invoice) : null;
  const history = useSubjectHistory(subject, typeof state === 'object' ? state.invoice.buyerAccount : null);
  // The Ethereum fallback checks roles in the buyer company's ENS registry, so the label must be that company's.
  useEffect(() => {
    if (typeof state !== 'object' || labelTouched.current) return;
    const c = companies.find((x) => isCompanyAccount(x, state.invoice.buyerAccount));
    const suffix = '.taz0r.eth';
    if (c?.ens?.endsWith(suffix)) setLabel(c.ens.slice(0, -suffix.length));
  }, [state, companies]);
  /** Adds an event to this invoice's timeline (no-op before an invoice is loaded). */
  const story = (kind: TimelineEvent['kind'], title: string, extra: Partial<TimelineEvent> = {}) => {
    if (subject) recordEvent({ subject, kind, at: Date.now(), title, ...extra });
  };

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
    const issued = issuedFromId(state.invoice.id);
    recordOpened(state.invoice, issued === null ? null : issued * 1000);
    upsertInbox({ ...inboxForInvoice(state.invoice, location.href), ...(hit ? { status: 'paid' as const } : {}) });
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
        const ok = onchain.toLowerCase() === local.toLowerCase();
        setGuard(ok
          ? { status: 'ok', digest: local }
          : { status: 'refused', reason: `On-chain digest ${onchain} does not match the invoice shown (${local}).` });
        const s = subjectOf(state.invoice);
        recordEvent(ok
          ? { subject: s, kind: 'policy-passed', at: Date.now(), title: `${state.invoice.id} passed the contract check`, detail: `${v2 ? 'PaymentModuleV2' : 'PaymentModule'} digest matches` }
          : { subject: s, kind: 'failed', at: Date.now(), title: `${state.invoice.id} refused: the contract does not match the invoice shown`, detail: 'the link may have been altered' });
      })
      .catch((e) => {
        setGuard({ status: 'refused', reason: `Could not read the on-chain digest: ${msg(e)}` });
        recordEvent({ subject: subjectOf(state.invoice), kind: 'failed', at: Date.now(), title: `${state.invoice.id}: contract check unavailable`, detail: plain(msg(e)).slice(0, 120) });
      });
  }, [state, v2]);

  useEffect(() => {
    if (typeof state !== 'object') return;
    const { paymentModule, wbSoulMirror } = config;
    if (!paymentModule || !wbSoulMirror) return setSupplier('error');
    setSupplier('checking');
    const s = subjectOf(state.invoice);
    const { id, supplierName } = state.invoice;
    const unverified = () => recordEvent({ subject: s, kind: 'supplier-unverified', at: Date.now(), title: `${id}: ${supplierName} not verified`, detail: 'WB Soul, simulated on testnet' });
    verifyCompany(state.invoice.supplierAccount, { paymentModule, mirror: wbSoulMirror })
      .then((v) => {
        setSupplier(v);
        if (v.verified) recordEvent({ subject: s, kind: 'supplier-verified', at: Date.now(), title: `${id}: ${supplierName} verified by WhiteBIT`, detail: 'WB Soul, simulated on testnet' });
        else unverified();
      })
      .catch(() => { setSupplier('error'); unverified(); });
  }, [state]);

  useEffect(() => {
    if (!tx || tx.seconds !== undefined) return;
    const t = setInterval(async () => {
      try {
        const r = await getReceipt(tx.hash);
        if (!r) return;
        setTx({ ...tx, seconds: (Date.now() - tx.started) / 1000, status: r.status === '0x1' ? 'success' : 'reverted' });
        if (typeof state === 'object') {
          const s = subjectOf(state.invoice);
          if (r.status === '0x1') {
            const submitted = eventsFor(s).find((e) => e.kind === 'submitted' && e.tx === tx.hash)?.at ?? tx.started;
            const secs = ((Date.now() - submitted) / 1000).toFixed(1);
            recordEvent({ subject: s, kind: 'paid', at: Date.now(), title: `${state.invoice.id} paid in ${secs} s`, detail: `settled in ${secs} s`, tx: tx.hash, chain: 'whitechain' });
            upsertInbox({ id: s, status: 'paid' });
            appendPayment({ invoice: state.invoice, txHash: tx.hash, blockTimestamp: await getBlockTimestamp(r.blockNumber) });
          } else {
            recordEvent({ subject: s, kind: 'failed', at: Date.now(), title: `${state.invoice.id} payment reverted`, detail: 'transaction reverted', tx: tx.hash, chain: 'whitechain' });
          }
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
        if (hit) {
          const seconds = (Date.now() - l1.started!) / 1000;
          setL1({ ...l1, l2Tx: hit.txHash, seconds });
          const s = subjectOf(state.invoice);
          recordEvent({ subject: s, kind: 'fallback-delivered', at: Date.now(), title: `${state.invoice.id} delivered via Ethereum in ${seconds.toFixed(0)} s`, detail: 'OptimismPortal deposit', tx: hit.txHash, chain: 'whitechain' });
          recordEvent({ subject: s, kind: 'paid', at: Date.now(), title: `${state.invoice.id} paid via Ethereum`, detail: `settled in ${seconds.toFixed(0)} s`, tx: hit.txHash, chain: 'whitechain' });
          upsertInbox({ id: s, status: 'paid' });
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [l1, state, v2]);

  // a toast when this session's payment lands (not for invoices that were already paid when opened)
  useEffect(() => {
    if (typeof state !== 'object') return;
    if (tx?.status === 'success' || l1?.l2Tx) toast(`Paid ${usdtNumber(state.invoice.amount)} USDT to ${state.invoice.supplierName}`);
    else if (tx?.status === 'reverted') toast('The payment reverted on Whitechain', 'error');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.status, l1?.l2Tx]);

  if (state === 'loading') return <div className="page"><PageHeader title="Invoice" subtitle="Decrypting invoice…" /></div>;
  if (state === 'none') return <Redirect to="/approvals/" label="Open Approvals" note="Paying starts from Approvals: paste or scan the payment link there." />;
  if (state === 'invalid') {
    return (
      <div className="page">
        <PageHeader title={<span data-testid="invalid">Invalid or tampered link</span>} subtitle="This payment link could not be decrypted. Ask the supplier to send it again." />
      </div>
    );
  }

  const { invoice: i, auth } = state;
  // colleagues' approvals arrive as TZA1 codes (or the older JSON); a code for another invoice is refused here
  const signedDigest = guard.status === 'ok' ? guard.digest : undefined;
  const pastedParse = (() => {
    try { return { list: parseApprovalInput(pasted, signedDigest), error: '' }; } catch (e) { return { list: null, error: msg(e) }; }
  })();
  const approvals = pastedParse.list === null ? null : mergeApprovals(mine ? [mine] : [], pastedParse.list);
  // contracts read inner signatures; an ERC-6492-wrapped approver must be deployed first (the relayer does this)
  const inner = (approvals ?? []).map((a) => ({ ...a, signature: unwrap6492(a.signature).inner }));
  const pendingDeploys = (approvals ?? []).map((a) => unwrap6492(a.signature)).filter((u) => u.factory);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) {
      setError(msg(e));
      story('failed', `${i.id}: ${(friendlyError(msg(e))?.title ?? plain(msg(e))).slice(0, 90)}`, { detail: plain(msg(e)).slice(0, 160) });
    } finally { setBusy(false); }
  };

  const onApprove = run(async () => {
    if (guard.status !== 'ok') return;
    const key = loadPasskey();
    if (!key) throw new Error('No passkey on this device. Create one on the onboarding page first.');
    const signature = await counterfactualApproval(key, await signInvoiceAuthWithPasskey(key.credentialId, guard.digest, key));
    setMine({ approver: key.approverAccount, signature });
    setMineAt(Date.now());
    const who = shortAddr(key.approverAccount);
    story('approved', `${i.id} approved by ${who}`, { actor: who, detail: 'passkey signature' });
    const others = pastedParse.list ?? [];
    const count = mergeApprovals([{ approver: key.approverAccount, signature }], others).length;
    const prev = loadInbox().find((x) => x.id === subject)?.approvals ?? 0;
    upsertInbox({ id: subject!, status: 'approved', approvals: Math.max(prev, count) });
  });

  const onPay = run(async () => {
    if (!approvals?.length) throw new Error('No approvals yet.');
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
    story('submitted', `${i.id} submitted via the relayer${body.paymentModule ? ` to ${v2 ? 'PaymentModuleV2' : 'PaymentModule'}` : ''}`, { detail: `${approvals.length} approval${approvals.length === 1 ? '' : 's'}`, tx: body.txHash, chain: 'whitechain' });
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
    story('fallback-sent', `${i.id} sent via Ethereum (${label.trim()}.taz0r.eth)`, { detail: 'EnsGate → OptimismPortal', tx: hash, chain: 'sepolia' });
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
  const chainPaid = history.events.find((e) => e.kind === 'paid' && e.tx)?.tx as Hex | undefined;
  const paidTx = (tx?.status === 'success' ? tx.hash : null) ?? l1?.l2Tx ?? paidBefore ?? chainPaid ?? null;
  const settledIn = tx?.status === 'success' && tx.seconds !== undefined ? tx.seconds
    : l1?.l2Tx && l1.seconds !== undefined ? l1.seconds : elapsed(history.events, 'submitted', 'paid');
  const amountText = usdtNumber(i.amount);

  // the guided steps, driven by the existing states
  type StepState = 'todo' | 'active' | 'done' | 'error';
  const s1: StepState = paidTx ? 'done' : guard.status === 'refused' ? 'error' : guard.status === 'checking' || supplier === 'checking' ? 'active' : 'done';
  const approved = !!mine || (approvals?.length ?? 0) > 0;
  const s2: StepState = paidTx || approved ? 'done' : s1 === 'done' ? 'active' : 'todo';
  const submitting = (!!tx && tx.status === undefined) || (!!l1?.hash && !l1.l2Tx) || (!!l1?.started && !l1.l2Tx);
  const s3: StepState = paidTx ? 'done' : tx?.status === 'reverted' ? 'error' : submitting ? 'active' : approved ? 'active' : 'todo';
  const s4: StepState = paidTx ? 'done' : 'todo';
  const steps: [string, StepState][] = [['Check supplier', s1], ['Approve with passkey', s2], [submitting ? 'Submitting…' : 'Submit payment', s3], ['Paid', s4]];
  const friendly = error ? friendlyError(error, { company: partyName(i.buyerAccount), supplier: i.supplierName }) : null;

  return (
    <div className="page tz-touch">
      <PageHeader
        title={`Invoice ${i.id}`}
        subtitle={<>From {i.supplierName}. Check what you are paying, then approve it with your passkey.</>}
      />
      <Toasts />
      <ol className="pay-steps" data-testid="pay-steps" aria-label="Payment progress">
        {steps.map(([label, st], n) => (
          <li key={n} className="pay-step" data-state={st} data-testid={`pay-step-${n + 1}`} aria-current={st === 'active' ? 'step' : undefined}>
            <span className="pay-step-n" aria-hidden="true">{st === 'done' ? '✓' : st === 'error' ? '!' : n + 1}</span>
            <span className="pay-step-label">{label}</span>
          </li>
        ))}
      </ol>
      {paidTx && (
        <section className="pay-success" data-testid="pay-success" aria-live="polite">
          <span className="pay-success-check" aria-hidden="true">✓</span>
          <div className="pay-success-body">
            <h2 data-testid="pay-success-amount">Paid {amountText} USDT to {i.supplierName}</h2>
            <p className="muted" data-testid="pay-success-time">
              {settledIn !== null ? `Settled on Whitechain in ${settledIn.toFixed(1)} s` : 'Settled on Whitechain'}
              {' · '}<a href={`${config.explorer}/tx/${paidTx}`} target="_blank" rel="noreferrer" data-testid="pay-success-tx">View transaction</a>
            </p>
            <div className="row">
              <button type="button" className="btn btn-primary" data-testid="pay-receipt" onClick={printInvoice}>Download receipt</button>
              <a className="btn" href="/invoices/" data-testid="pay-back">Back to invoices</a>
            </div>
          </div>
        </section>
      )}
      {v2 && <p className="small muted" data-testid="v2-account" data-module={configV2.paymentModule ?? ''} style={{ margin: 0 }}>This company uses PaymentModuleV2: its spending limits and payee rules apply to this payment.</p>}

      <div className="pay-split">
        <div className="stack">
          <InvoicePaper invoice={paperFromInvoice(i)} status={paidTx ? 'paid' : 'sent'} link={location.href} txHash={paidTx} />
          <p className="small muted">Decrypted from the link on this device; nothing was sent to a server.</p>
        </div>

        <div className="stack paper-sticky pay-actions">
          <Card title="Approve and pay" subtitle="Your passkey signs exactly this invoice; then anyone can submit the payment.">
            <div className="stack">
              <dl className="kv">
                <dt>From</dt>
                <dd>
                  <span className="stack" style={{ gap: 4 }}>
                    <span>{i.supplierName}</span>
                    <AddrChip value={i.supplierAccount} href={explorer(i.supplierAccount)} />
                    <span className="pill-wrap">
                      {supplier === 'checking' ? <Pill testId="supplier-checking">checking…</Pill>
                        : typeof supplier === 'object' && supplier.verified
                          ? <span title="Verified by WhiteBIT (simulated on testnet)"><Pill tone="positive" testId="supplier-verified">✓ Verified by WhiteBIT · simulated</Pill></span>
                          : <Pill testId="supplier-unverified">Not verified</Pill>}
                    </span>
                  </span>
                </dd>
                <dt>Amount</dt><dd className="num" data-testid="amount">{amt(i.amount)}</dd>
                <dt>Due</dt><dd className="num">{day(i.dueDate)}</dd>
              </dl>
              {guard.status === 'checking' && <Notice testId="guard-checking">Checking what you will sign against the contract…</Notice>}
              {guard.status === 'refused' && (
                <Notice tone="negative" testId="guard-refused">
                  <span className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span>Refusing to sign: {/does not match/.test(guard.reason)
                      ? 'the contract does not match the invoice shown, so the link may have been altered. Ask the supplier for a new link.'
                      : /not configured/.test(guard.reason) ? 'this app has no payment contract configured.'
                        : "the page could not check this invoice with the contract right now. Try again in a minute."}</span>
                    <details className="small error-detail"><summary>For developers</summary>{guard.reason}</details>
                  </span>
                </Notice>
              )}
              {guard.status === 'ok' && (
                <div data-testid="guard-ok" data-digest={guard.digest}>
                  <Notice tone="positive"><span style={{ minWidth: 0 }}>✓ The contract agrees on exactly this invoice: {i.id}, {amt(i.amount)} to {i.supplierName}.</span></Notice>
                </div>
              )}
              <div className="row">
                <button data-testid="approve" className={mine || paidTx ? 'btn' : 'btn btn-primary'} onClick={onApprove} disabled={busy || guard.status !== 'ok'}>Approve with passkey</button>
                <button data-testid="pay" className={mine && !paidTx ? 'btn btn-primary' : 'btn'} onClick={onPay} disabled={busy || !approvals?.length}>Pay</button>
                <span className="small muted">Approvals: <span className="num" data-testid="approval-count">{approvals?.length ?? 0}</span></span>
              </div>
              <p className="small muted" style={{ margin: 0 }}>Face ID, fingerprint or your device PIN unlocks the passkey. Nothing leaves this device except the signature.</p>
              {error && (
                <Notice tone="negative" testId="error">
                  {friendly ? (
                    <span className="stack" style={{ gap: 4, minWidth: 0 }}>
                      <b data-testid="error-title">{friendly.title}</b>
                      <span>{friendly.fix}{friendly.href && <> <a href={friendly.href}>Open</a></>}</span>
                      <details className="small error-detail"><summary>For developers</summary>{error}</details>
                    </span>
                  ) : (
                    <span className="stack" style={{ gap: 4, minWidth: 0 }}>
                      <span className="break">{plain(error)}</span>
                      {hasHex(error) && <details className="small error-detail"><summary>For developers</summary>{error}</details>}
                    </span>
                  )}
                </Notice>
              )}
              {tx && (
                <div data-testid="tx" data-tx={tx.hash}>
                <Notice tone={tx.status === 'reverted' ? 'negative' : tx.status === 'success' ? 'positive' : 'info'}><span style={{ minWidth: 0 }}>
                  {tx.seconds === undefined ? 'Payment sent, waiting for Whitechain…' : tx.status === 'success' ? `Payment confirmed in ${tx.seconds.toFixed(1)} s` : `The payment reverted after ${tx.seconds.toFixed(1)} s`}
                  {' · '}<a href={`${config.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">View transaction</a>
                  {tx.status === 'success' && <> · <a href="/export/">Export for accounting</a></>}
                </span></Notice>
                </div>
              )}
              <details className="colleagues" open={!!pasted.trim() || !!mine || undefined} data-testid="colleagues">
                <summary>Need a second approver?</summary>
                <div className="stack">
                  {mine && signedDigest && <MyApproval approval={mine} at={mineAt || Date.now()} digest={signedDigest} what={i.id} testId="my-approval" shareTestId="share-approval" />}
                  <Field label="Paste an approval a colleague shared">
                    <textarea data-testid="pasted" className="textarea" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={2} placeholder="Tazor approval for INV-…: TZA1.…" />
                  </Field>
                  {pastedParse.list && <ApprovalNames approvals={pastedParse.list} testId="pasted-approvals" />}
                  {pastedParse.error && <Notice tone="negative" testId="pasted-error">{pastedParse.error}</Notice>}
                </div>
              </details>
              <div className="pay-more">
                <button data-testid="calldata" className="btn btn-sm btn-ghost" onClick={onCopyCalldata} disabled={busy || !approvals?.length}>Copy calldata</button>
                {v2 && <button data-testid="pay-as-agent" className="btn btn-sm btn-ghost" onClick={onPayAsAgent} disabled={busy || !mine}>Pay as agent (calldata)</button>}
              </div>
              {(calldata || l1) && pendingDeploys.map((u) => (
                <div key={u.factoryCalldata} data-testid="deploy-first" data-value={u.factoryCalldata}>
                  <Notice tone="warning">Your approver account is created first: one extra transaction, sent from any wallet. Its data is under For developers below.</Notice>
                </div>
              ))}
              {calldata && <p className="small muted">Calldata copied. It is also under For developers below.</p>}
            </div>
          </Card>

          <Card title="Activity" subtitle="What happened to this invoice, as seen from this device.">
            <HistoryTimeline events={history.events} loading={history.loading} error={history.error} steps={INVOICE_STEPS} testId="pay-timeline" />
          </Card>

          <div data-tour="pay-fallback">
          <Card title="Send via Ethereum" subtitle="Works with Tazor's relayer and Whitechain's sequencer down.">
            <div className="stack">
              <p className="muted">
                The payment goes to EnsGate on Ethereum, which checks the approvers&apos; ENS roles and delivers it to Whitechain
                through the OptimismPortal (about a minute).
              </p>
              <Field label="Company name">
                <span className="input-affix">
                  <input data-testid="label" className="input" value={label} onChange={(e) => { labelTouched.current = true; setLabel(e.target.value); }} />
                  <span>.taz0r.eth</span>
                </span>
              </Field>
              <div className="row">
                <button data-testid="prepare-l1" className="btn" onClick={onPrepareL1} disabled={busy || !approvals?.length}>Prepare Ethereum transaction</button>
              </div>
              {l1 && (
                <div data-testid="l1" className="stack">
                  <p className="muted">To Tazor&apos;s EnsGate {gate && <AddrChip value={gate} href={`${config.sepolia.explorer}/address/${gate}`} />} on Ethereum Sepolia. {l1.fee !== undefined
                    ? <span data-testid="l1-fee">Estimated fee: {formatEther(l1.fee)} ETH ({l1.gas?.toString()} gas)</span>
                    : l1.feeError ? <span data-testid="l1-fee-error">Fee estimate failed: {l1.feeError}</span> : 'Estimating fee…'}</p>
                  <div className="row">
                    <button data-testid="send-l1" className="btn" onClick={onSendL1} disabled={busy || !!l1.hash}>Send with your wallet</button>
                    <button data-testid="copy-l1" className="btn" onClick={() => navigator.clipboard?.writeText(JSON.stringify({ to: gate, data: l1.data })).catch(() => undefined)}>Copy calldata</button>
                    <button data-testid="watch-l1" className="btn" onClick={onWatchL1} disabled={busy || !!l1.started}>I sent it myself, watch for delivery</button>
                  </div>
                  <p className="small muted">The raw calldata is under For developers below.</p>
                  {l1.hash && <p data-tx={l1.hash}>Sent on Ethereum · <a href={`${config.sepolia.explorer}/tx/${l1.hash}`} target="_blank" rel="noreferrer">View on Etherscan</a></p>}
                  {l1.started && (
                    <Notice tone={l1.l2Tx ? 'positive' : 'info'} testId="l1-status"><span>{l1.l2Tx
                      ? <>Delivered on Whitechain in {l1.seconds?.toFixed(0)} s · <a href={`${config.explorer}/tx/${l1.l2Tx}`} target="_blank" rel="noreferrer">View transaction</a></>
                      : 'Waiting for the deposit to reach Whitechain…'}</span></Notice>
                  )}
                </div>
              )}
            </div>
          </Card>
          </div>

          <Card>
            <details className="tech-details" data-testid="for-developers">
              <summary>For developers</summary>
              <div className="stack">
                <dl className="kv">
                  <dt>Pay to</dt><dd><AddrChip value={i.payee} name={partyName(i.payee)} href={explorer(i.payee)} /></dd>
                  <dt>Buyer account</dt><dd><AddrChip value={i.buyerAccount} name={partyName(i.buyerAccount)} href={explorer(i.buyerAccount)} /></dd>
                  <dt>Token</dt><dd><AddrChip value={i.token} name="USDT" href={explorer(i.token)} /></dd>
                  <dt>Invoice hash</dt><dd><span className="mono break" data-testid="invoice-hash">{auth.invoiceHash}</span></dd>
                  <dt>Payment module</dt><dd><span className="mono break">{pm}</span></dd>
                  {guard.status === 'ok' && <><dt>Signed digest</dt><dd><span className="mono break">{guard.digest}</span></dd></>}
                  <dt>Approval valid until</dt><dd className="num">{day(auth.expiry)}</dd>
                </dl>
                {calldata && (
                  <div className="well">
                    <p className="small muted">Send this calldata to PaymentModule <span className="mono">{pm}</span> from any wallet on Whitechain</p>
                    <code data-testid="calldata-out" className="mono break">{calldata}</code>
                  </div>
                )}
                {(calldata || l1) && pendingDeploys.map((u) => (
                  <div className="well" key={`dev-${u.factoryCalldata}`}>
                    <p className="small muted">First send this to the ApproverAccountFactory <span className="mono">{u.factory}</span></p>
                    <code className="mono break">{u.factoryCalldata}</code>
                  </div>
                ))}
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
