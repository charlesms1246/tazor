'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '@/lib/config.ts';
import { cancelSubscription, demoName, methodLabel, shortRef, walletSigner, type Signer, type TypedData } from '@/lib/checkout.ts';
import { companyByAccount } from '@/lib/company.ts';
import { customerHistory, type CustomerHistory } from '@/lib/customer.ts';
import { ensLabelOf } from '@/lib/ens-directory.ts';
import { plain } from '@/lib/human.ts';
import { usdtText } from '@/lib/money.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { AddrChip } from '../_human/chip.tsx';
import { toast, Toasts } from '../_invoice/toast.tsx';
import { Card, Empty, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import '../_invoice/touch.css';
import '../_checkout/checkout.css';
import './me.css';

/** The same in-browser wallet the pay button's "Pay with a demo wallet" uses (testnet only). */
const DEMO_WALLET_KEY = 'tazor.demo-wallet.v1';
const ME_KEY = 'tazor.me.v1';
type Eth = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const injected = (): Eth | null => (globalThis as { ethereum?: Eth }).ethereum ?? null;
type Who = { address: Address; how: 'wallet' | 'demo' | 'pasted' };

const demoKey = (): Hex | null => { try { return (localStorage.getItem(DEMO_WALLET_KEY) as Hex | null) || null; } catch { return null; } };
const demoSigner = (): Signer | null => {
  const pk = demoKey();
  if (!pk) return null;
  const a = privateKeyToAccount(pk);
  return { address: a.address, signTypedData: (td: TypedData) => a.signTypedData(td as never) };
};
const business = (a: string) => companyByAccount(a)?.name ?? ensLabelOf(a) ?? demoName(a);
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const every = (s: number) => (s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** "My payments": a customer's Checkout payments, refunds and subscriptions across every business, from Whitechain. */
export default function MyPaymentsPage() {
  const [who, setWho] = useState<Who | null>(null);
  const [paste, setPaste] = useState('');
  const [hasDemo, setHasDemo] = useState(false);
  const [data, setData] = useState<CustomerHistory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setHasDemo(!!demoKey());
    const q = new URLSearchParams(location.search).get('address')?.trim() ?? '';
    const d = demoSigner();
    if (isAddress(q, { strict: false })) {
      const a = getAddress(q);
      setWho({ address: a, how: d && d.address === a ? 'demo' : 'pasted' });
      return;
    }
    try { const saved = JSON.parse(sessionStorage.getItem(ME_KEY) ?? 'null') as Who | null; if (saved && isAddress(saved.address)) setWho(saved); } catch { /* none */ }
  }, []);
  const choose = (w: Who) => { setWho(w); setData(null); try { sessionStorage.setItem(ME_KEY, JSON.stringify(w)); } catch { /* private mode */ } };

  const load = useCallback(async () => {
    if (!who) return;
    setError('');
    try { setData(await customerHistory(who.address)); } catch (e) { setError(plain(e instanceof Error ? e.message : String(e))); }
  }, [who]);
  useEffect(() => { void load(); }, [load]);

  const useWallet = async () => {
    const eth = injected();
    if (!eth) return toast('No wallet in this browser. Use the demo wallet, or paste your address.', 'error');
    try { const [a] = (await eth.request({ method: 'eth_requestAccounts' })) as string[]; if (a) choose({ address: getAddress(a), how: 'wallet' }); }
    catch { toast('The wallet did not share an address', 'error'); }
  };
  const useDemo = () => { const d = demoSigner(); if (d) choose({ address: d.address, how: 'demo' }); };
  const usePasted = () => { if (!isAddress(paste.trim(), { strict: false })) return toast('Enter a wallet address (0x…, 42 characters)', 'error'); choose({ address: getAddress(paste.trim()), how: 'pasted' }); setPaste(''); };

  const cancel = (id: Hex) => async () => {
    if (!who) return;
    setBusy(id);
    try {
      const signer = who.how === 'demo' ? demoSigner() : who.how === 'wallet' && injected() ? await walletSigner(injected() as never) : null;
      if (!signer) throw new Error('Connect the wallet that pays this subscription to cancel it.');
      if (signer.address.toLowerCase() !== who.address.toLowerCase()) throw new Error(`Your wallet is ${signer.address.slice(0, 6)}…${signer.address.slice(-4)}; switch to ${who.address.slice(0, 6)}…${who.address.slice(-4)}.`);
      await cancelSubscription({ id, wallet: signer, relayer: getRelayerUrl() });
      toast('Subscription cancelled; no more charges');
      await load();
    } catch (e) { toast(plain(e instanceof Error ? e.message : String(e)), 'error'); }
    finally { setBusy(''); }
  };

  return (
    <div className="page tz-touch me-page">
      <Toasts />
      <PageHeader title="My payments" subtitle="Every Checkout payment you made, across all businesses: receipts, refunds and subscriptions." />
      <Notice testId="me-source">Your records come from Whitechain: no account, no merchant login.</Notice>

      <Card title={who ? 'Showing payments from' : 'Whose payments?'} testId="me-who">
        {who && (
          <div className="me-who" data-testid="me-address">
            <AddrChip value={who.address} href={`${config.explorer}/address/${who.address}`} />
            <Pill tone={who.how === 'pasted' ? 'neutral' : 'positive'}>{who.how === 'wallet' ? 'Your wallet' : who.how === 'demo' ? 'Demo wallet in this browser' : 'Read only'}</Pill>
          </div>
        )}
        <div className="row me-pick">
          <button type="button" className="btn" data-testid="me-use-wallet" onClick={useWallet}>Use my wallet</button>
          {hasDemo && <button type="button" className="btn" data-testid="me-use-demo" onClick={useDemo}>Use the demo wallet in this browser</button>}
        </div>
        <div className="co-form" style={{ marginTop: 8 }}>
          <input className="input mono" data-testid="me-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Or paste an address (0x…) to look only" aria-label="Wallet address" spellCheck={false} />
          <button type="button" className="btn" data-testid="me-paste-go" onClick={usePasted}>Show</button>
        </div>
      </Card>

      {who && (error ? <Notice tone="negative" testId="me-error">Whitechain could not be read: {error}. <button type="button" className="btn btn-sm" onClick={() => void load()}>Retry</button></Notice>
        : data === null ? <Card><p className="muted" style={{ margin: 0 }} data-testid="me-loading">Reading your payments from Whitechain…</p></Card>
          : (<>
            <section className="me-kpis" data-testid="me-kpis">
              <div><span className="kpi-label">Paid</span><b className="num" data-testid="me-paid">{usdtText(data.totals.paid)}</b><span className="cell-sub">{data.orders.length} payment{data.orders.length === 1 ? '' : 's'}</span></div>
              <div><span className="kpi-label">Refunds received</span><b className="num" data-testid="me-refunded">{usdtText(data.totals.refunded)}</b></div>
              <div><span className="kpi-label">Net paid</span><b className="num" data-testid="me-net">{usdtText(data.totals.net)}</b></div>
            </section>

            <Card title="Payments" flush testId="me-orders-card">
              {data.orders.length === 0 ? <div style={{ padding: '0 var(--card-pad) var(--card-pad)' }}><Empty><span data-testid="me-empty">No Checkout payments from this address yet.</span></Empty></div> : (
                <div className="table-wrap"><table className="table table-stack me-orders" data-testid="me-orders">
                  <thead><tr><th>Date</th><th>Business</th><th>Order</th><th className="num">Paid</th><th className="num">Refunded</th><th className="num">Net</th></tr></thead>
                  <tbody>{data.orders.map((o) => (
                    <tr key={o.id} data-testid="me-order-row">
                      <td>{day(o.paidAt)}<span className="cell-sub">{methodLabel(o.method)}</span></td>
                      <td>{business(o.merchant) && <b>{business(o.merchant)} </b>}<AddrChip value={o.merchant} href={`${config.explorer}/address/${o.merchant}`} /></td>
                      <td><a href={`/receipt/?order=${o.id}`} data-testid="me-receipt">{shortRef(o.id)} · Receipt</a></td>
                      <td className="num" data-label="Paid">{usdtText(o.amount)}</td>
                      <td className="num" data-label="Refunded">{o.refunded > 0n ? usdtText(o.refunded) : <span className="faint">—</span>}{o.refunds.length > 0 && <span className="cell-sub">{o.refunds.length} refund{o.refunds.length === 1 ? '' : 's'}</span>}</td>
                      <td className="num" data-label="Net"><b>{usdtText(o.net)}</b></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>

            <Card title="Subscriptions" subtitle="Cancel any time: you sign once in your wallet and no more charges can be taken." flush testId="me-subs-card">
              {data.subs.length === 0 ? <div style={{ padding: '0 var(--card-pad) var(--card-pad)' }}><Empty><span data-testid="me-subs-empty">No subscriptions from this address.</span></Empty></div> : (
                <div className="table-wrap"><table className="table table-stack" data-testid="me-subs">
                  <thead><tr><th>Business</th><th className="num">Amount</th><th>Charged</th><th>Next charge</th><th /></tr></thead>
                  <tbody>{data.subs.map((s) => (
                    <tr key={s.id} data-testid="me-sub-row">
                      <td>{business(s.merchant) && <b>{business(s.merchant)} </b>}<AddrChip value={s.merchant} /></td>
                      <td className="num">{usdtText(s.amount)}<span className="cell-sub">every {every(s.period)}</span></td>
                      <td>{s.charged} of {s.cycles}</td>
                      <td data-testid="me-sub-next">{!s.active ? <Pill>Cancelled</Pill> : s.charged >= s.cycles ? <Pill>Finished</Pill> : s.nextAt && s.nextAt <= Date.now() ? 'Due now' : day(s.nextAt)}</td>
                      <td>{s.active && s.charged < s.cycles && (who.how === 'pasted'
                        ? <span className="small muted">Connect this wallet to cancel</span>
                        : <button type="button" className="btn btn-sm" data-testid="me-cancel" disabled={!!busy} onClick={cancel(s.id)}>{busy === s.id ? 'Cancelling…' : 'Cancel'}</button>)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          </>))}
    </div>
  );
}
