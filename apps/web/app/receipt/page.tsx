'use client';

import { useCallback, useEffect, useState } from 'react';
import { isHex, type Address, type Hex } from 'viem';
import { config } from '@/lib/config.ts';
import {
  blockTime, checkoutAddress, DEFAULT_SHIP_POLICY, depositCheckoutAddress, finalityStage, methodLabel, orderEvents, orderRef, readyToShip, readFinality, readPayment, shortRef,
  type CheckoutEvent, type Finality, type Payment,
} from '@/lib/checkout.ts';
import { companyByAccount } from '@/lib/company.ts';
import { ensLabelOf } from '@/lib/ens-directory.ts';
import { usdtText } from '@/lib/money.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Inr } from '../_invoice/inr.tsx';
import { Qr } from '../_invoice/paper.tsx';
import { toast, Toasts } from '../_invoice/toast.tsx';
import { Card, Empty, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import '../_invoice/touch.css';
import '../_invoice/paper.css';
import '../_checkout/checkout.css';
import '../_invoice/reminder.css';
import { MerchantBadge } from '../_soul/merchant-badge.tsx';
import { RefundRequest } from '../_checkout/refund-request.tsx';

const nameOf = (a: string) => companyByAccount(a)?.name ?? ensLabelOf(a) ?? null;
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null);
const explorerTx = (tx: string) => `${config.explorer}/tx/${tx}`;

type Loaded = { id: Hex; payment: Payment; events: CheckoutEvent[]; paidBlock: number | null; paidTx: Hex | null; number: string | null };

/** A public receipt for a TazorCheckout order, read straight from Whitechain (works with Tazor's relayer down). */
export default function ReceiptPage() {
  const [id, setId] = useState<Hex | null>(null);
  const [state, setState] = useState<'loading' | 'bad-id' | 'not-configured' | 'unpaid' | 'error' | Loaded>('loading');
  const [error, setError] = useState('');
  const [fin, setFin] = useState<Finality | null>(null);
  const [times, setTimes] = useState<{ paid: number | null; safe: number | null; final: number | null }>({ paid: null, safe: null, final: null });
  const [href, setHref] = useState('');
  const [claimed, setClaimed] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('order') ?? '';
    setClaimed(params.get('ref')?.trim() || null);
    setHref(location.href);
    if (!isHex(q) || q.length !== 66) return setState('bad-id');
    setId(q.toLowerCase() as Hex);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    if (!checkoutAddress() && !depositCheckoutAddress()) return setState('not-configured');
    try {
      const payment = await readPayment(id);
      if (!payment) return setState('unpaid');
      const events = await orderEvents(id, payment.contract).catch(() => [] as CheckoutEvent[]);
      // RPC logs carry no time; read each block's timestamp once
      const blocks = [...new Set(events.filter((e) => e.at === undefined).map((e) => e.block))];
      const at = new Map(await Promise.all(blocks.map(async (b) => [b, await blockTime(b).catch(() => null)] as const)));
      const timed = events.map((e) => (e.at === undefined && at.get(e.block) ? { ...e, at: at.get(e.block)! } : e));
      const paid = timed.find((e) => e.kind === 'paid');
      // the merchant's order number, shown only when it hashes to the ref on chain
      const ref = paid && paid.kind === 'paid' ? paid.ref : null;
      const number = claimed && ref && orderRef(claimed).toLowerCase() === ref.toLowerCase() ? claimed : null;
      setState({ id, payment, events: timed, paidBlock: paid?.block ?? null, paidTx: paid?.tx ?? null, number });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState((s) => (typeof s === 'object' ? s : 'error'));
    }
  }, [id, claimed]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);

  // the three finality stages, polled until final; each stage's time is the head block's time when we first saw it pass
  const paidBlock = typeof state === 'object' ? state.paidBlock : null;
  useEffect(() => {
    if (paidBlock === null) return;
    let stop = false;
    const tick = async () => {
      const f = await readFinality(paidBlock);
      if (stop) return;
      setFin(f);
      const [paidAt, safeAt, finalAt] = await Promise.all([
        times.paid ?? blockTime(paidBlock).catch(() => null),
        times.safe ?? (f.safe !== null && f.safe >= paidBlock ? blockTime(f.safe).catch(() => Date.now()) : null),
        times.final ?? (f.finalized !== null && f.finalized >= paidBlock ? blockTime(f.finalized).catch(() => Date.now()) : null),
      ]);
      if (!stop) setTimes({ paid: paidAt, safe: safeAt, final: finalAt });
    };
    void tick();
    const t = setInterval(() => { if (!fin || finalityStage(fin) < 3) void tick(); }, 10_000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidBlock, fin === null || finalityStage(fin) === 3]);

  const header = <PageHeader title="Receipt" subtitle="A public receipt for a payment made with Tazor Checkout. Read from Whitechain, not from Tazor." />;
  if (state === 'loading') return <div className="page tz-touch">{header}<p className="muted" data-testid="receipt-loading">Reading Whitechain…</p></div>;
  if (state === 'bad-id') return <div className="page tz-touch">{header}<Notice tone="negative" testId="receipt-bad-id">This receipt link is incomplete. Ask the merchant for the full link.</Notice></div>;
  if (state === 'not-configured') return <div className="page tz-touch">{header}<Notice testId="receipt-not-configured">Checkout is not deployed in this build yet, so there is no receipt to read.</Notice></div>;
  if (state === 'error') return <div className="page tz-touch">{header}<Notice tone="negative" testId="receipt-error">Whitechain could not be reached right now. This page retries every 30 seconds.</Notice></div>;
  if (state === 'unpaid') return (
    <div className="page tz-touch">{header}
      <Card><Empty><span data-testid="receipt-unpaid">No payment for this order yet. If you just paid, it appears here within seconds.</span></Empty>
        <div className="row" style={{ marginTop: 12 }}><button type="button" className="btn" onClick={() => void load()}>Check again</button></div>
      </Card>
    </div>
  );

  const { payment: p, events } = state;
  const net = p.amount - p.refunded;
  const status = p.refunded === 0n ? 'Paid' : p.refunded >= p.amount ? 'Refunded' : 'Partly refunded';
  const refunds = events.filter((e): e is Extract<CheckoutEvent, { kind: 'refunded' | 'returned' }> => e.kind === 'refunded' || e.kind === 'returned');
  const stage = fin ? finalityStage(fin) : 1;
  const ship = readyToShip(p.amount, (['pending', 'sequencer', 'ethereum', 'finalized'] as const)[stage]);
  const steps: [string, string, number | null][] = [
    ['Confirmed by Whitechain', 'about 1 second after paying', times.paid ?? p.paidAt * 1000],
    ['Posted to Ethereum', "in a batch on Ethereum (Whitechain's safe head passed the block)", times.safe],
    ['Final', "Ethereum finalized that batch (Whitechain's finalized head)", times.final],
  ];
  const merchantName = nameOf(p.merchant);
  const payerName = nameOf(p.payer);
  const explorer = (a: Address) => `${config.explorer}/address/${a}`;

  return (
    <div className="page tz-touch">
      <Toasts />
      {header}
      {error && <Notice tone="warning">Showing the last reading; Whitechain did not answer the latest check.</Notice>}
      <Card>
        <div className="stack">
          <div className="receipt-hero">
            <h2 data-testid="receipt-amount">{usdtText(p.amount)}</h2>
            <Inr v={p.amount} />
            <Pill tone={status === 'Paid' ? 'positive' : status === 'Refunded' ? 'neutral' : 'warning'} testId="receipt-status">{status}</Pill>
          </div>
          <dl className="kv">
            <dt>Merchant</dt><dd data-testid="receipt-merchant">{merchantName && <b>{merchantName} </b>}<AddrChip value={p.merchant} href={explorer(p.merchant)} />
              <MerchantBadge merchant={p.merchant} /></dd>
            <dt>Paid with</dt><dd data-testid="receipt-method">{methodLabel(p.method)}</dd>
            <dt>{p.method === 'signed' ? 'Paid by' : 'Refunds go to'}</dt><dd>{payerName && <b>{payerName} </b>}<AddrChip value={p.payer} href={explorer(p.payer)} /></dd>
            <dt>Paid</dt><dd className="num" data-testid="receipt-paid-at">{when(p.paidAt * 1000)}{state.paidTx && <> · <a href={explorerTx(state.paidTx)} target="_blank" rel="noreferrer" data-tx={state.paidTx}>View transaction</a></>}</dd>
            {p.refunded > 0n && <><dt>Refunded</dt><dd className="num" data-testid="receipt-refunded">{usdtText(p.refunded)} in {p.refunds} refund{p.refunds === 1 ? '' : 's'}</dd></>}
            <dt>For the merchant</dt><dd data-testid="receipt-ship" data-ready={ship.ready ? 'true' : 'false'} title={ship.reason}>
              <Pill tone={ship.ready ? 'positive' : 'warning'}>{ship.ready ? 'Ready to ship' : 'Wait: big payment'}</Pill>
              <span className="cell-sub">{ship.ready ? ship.reason.replace(/^Ready to ship: /, '') : `${DEFAULT_SHIP_POLICY.waitForEthereumAbove} USDT and above waits until Whitechain posts it to Ethereum (about 10 minutes)`}</span></dd>
            <dt>Net paid</dt><dd className="num" data-testid="receipt-net"><b>{usdtText(net)}</b> <Inr v={net} /></dd>
            <dt>Order</dt><dd data-testid="receipt-order">{state.number ?? shortRef(state.id)}</dd>
          </dl>
        </div>
      </Card>

      <Card title="How final is this payment?" subtitle="Whitechain confirms in about a second, then posts its blocks to Ethereum, which makes them final. This updates by itself.">
        <ol className="finality" data-testid="receipt-finality" data-stage={stage}>
          {steps.map(([title, sub, at], n) => (
            <li key={title} data-testid={`receipt-stage-${n + 1}`} data-state={stage > n ? 'done' : stage === n ? 'active' : 'todo'}>
              <span className="fin-n" aria-hidden="true">{stage > n ? '✓' : n + 1}</span>
              <span className="fin-text">
                <span className="fin-title">{title}</span>
                <span className="fin-sub">{stage > n ? (at ? `${n === 0 ? '' : 'by '}${when(at)}` : 'done') : stage === n ? (n === 2 ? 'waiting… usually about 30 min after posting to Ethereum' : n === 1 ? 'waiting… usually about 10 min after paying' : 'waiting…') : sub}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {refunds.length > 0 && (
        <Card title="Refunds" subtitle={p.method === 'signed' ? 'Refunds go back to the address that paid; the merchant cannot send them anywhere else.' : 'Refunds go to the refund address set for this order; the merchant cannot send them anywhere else.'} flush>
          <div className="table-wrap"><table className="table table-stack receipt-refunds" data-testid="receipt-refunds">
            <thead><tr><th>When</th><th>What</th><th className="num">Amount</th><th>Transaction</th></tr></thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.tx} data-testid="receipt-refund-row">
                  <td>{when(r.at ?? null) ?? <span className="faint">—</span>}</td>
                  <td>{r.kind === 'returned' ? 'Extra sent back (paid more than the order)' : 'Refund'}</td>
                  <td className="num">{usdtText(r.amount)}</td>
                  <td><a href={explorerTx(r.tx)} target="_blank" rel="noreferrer" data-tx={r.tx}>View transaction</a></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      {net > 0n && (
        <RefundRequest orderId={state.id} merchant={p.merchant} business={merchantName} order={state.number ?? shortRef(state.id)} paid={usdtText(p.amount).replace(/ USDT$/, '')}
          paidOn={p.paidAt ? new Date(p.paidAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null} refundable={Number(net) / 1e6} />
      )}

      <p className="small" style={{ margin: 0 }}><a href={`/me/?address=${p.payer}`} data-testid="receipt-my-payments">All my payments →</a> <span className="muted">every Checkout payment from {p.method === 'signed' ? 'this wallet' : 'this refund address'}, across all businesses</span></p>

      <Card title="Share this receipt" subtitle="Anyone with the link can check it on Whitechain.">
        <div className="receipt-share">
          <div className="receipt-qr-col">
            {href && <Qr link={href} testId="receipt-qr" />}
            <button type="button" className="btn btn-sm" data-testid="receipt-copy-link" data-link={href}
              onClick={() => navigator.clipboard?.writeText(href).then(() => toast('Receipt link copied'), () => toast('Could not copy; copy the address bar instead', 'error'))}>Copy link</button>
          </div>
          <span className="small muted">Read from Whitechain, not from Tazor: it works even if Tazor is offline.</span>
        </div>
      </Card>
    </div>
  );
}
