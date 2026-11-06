'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { config } from '@/lib/config.ts';
import {
  allCheckoutLogs, cancelSubscription, chargeSubscription, checkoutAddress, decodeCheckoutLogs, depositCheckoutAddress, merchantView, methodLabel,
  nextCharge, refundOrder, shortRef, walletSigner, type OrderRow, type SubRow,
} from '@/lib/checkout.ts';
import { companyByAccount, useCompany } from '@/lib/company.ts';
import { ensLabelOf } from '@/lib/ens-directory.ts';
import { parseUsdt } from '@/lib/invoices-store.ts';
import { usdtText } from '@/lib/money.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { plain } from '@/lib/human.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Inr } from '../_invoice/inr.tsx';
import { toast, Toasts } from '../_invoice/toast.tsx';
import { Card, Empty, Notice, PageHeader, Pill } from '../_ui/index.tsx';
import '../_invoice/touch.css';
import '../_checkout/checkout.css';

type Tab = 'orders' | 'subscriptions' | 'webhooks' | 'agents';
const TABS: { id: Tab; label: string }[] = [
  { id: 'orders', label: 'Orders' }, { id: 'subscriptions', label: 'Subscriptions' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'agents', label: 'Agents' },
];
const WATCH_KEY = 'tazor.checkout.watch.v1';
const DEMO_KEY = 'tazor.checkout.demo.v1';
/** Live demo merchants with real orders on Whitechain, shown by default so the console never opens empty. */
const DEMO_MERCHANTS: { name: string; account: Address }[] = [
  { name: 'Bluejay demo shop', account: '0xc1dce946D192e344251972470237F1471C93876c' },
  { name: 'Sandbox merchant', account: '0x6B4E065d08D2cC7723635c6df0CC5268C706cD93' },
];
/** The demo x402 resource server's payTo. */
const DEMO_PAYTO: Address = '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6';
const isTab = (t: string | null): t is Tab => t === 'orders' || t === 'subscriptions' || t === 'webhooks' || t === 'agents';
const demoName = (a: string) => DEMO_MERCHANTS.find((d) => d.account.toLowerCase() === a.toLowerCase())?.name ?? (a.toLowerCase() === DEMO_PAYTO.toLowerCase() ? 'Demo AI resource' : null);
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const nameOf = (a: string) => companyByAccount(a)?.name ?? ensLabelOf(a) ?? null;
const every = (s: number) => (s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const msg = (e: unknown) => plain(e instanceof Error ? e.message : String(e));

type Eth = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const injected = (): Eth | null => (globalThis as { ethereum?: Eth }).ethereum ?? null;

type Delivery = { id: string; type: string; created: number | string; txHash?: string; status: string; attempts: number; httpStatus?: number };
type Settlement = { id: string; created: number | string; txHash: string; payer: string; amount: string; resource: string; network: string };
const asMs = (v: number | string) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

export default function CheckoutPage() {
  const company = useCompany();
  const checkout = checkoutAddress() ?? depositCheckoutAddress();
  const relayer = getRelayerUrl();
  const [tab, setTabState] = useState<Tab>('orders');
  const [linked, setLinked] = useState<Address | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [demo, setDemo] = useState(true);
  // deep links: ?merchant=0x…&tab=agents, or /checkout/#subscriptions
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const m = q.get('merchant')?.trim() ?? '';
    if (isAddress(m)) setLinked(getAddress(m));
    const o = q.get('order')?.trim().toLowerCase() ?? '';
    if (/^0x[0-9a-f]{64}$/.test(o)) setFocus(o);
    const t = q.get('tab');
    if (isTab(t)) setTabState(t);
    try { if (localStorage.getItem(DEMO_KEY) === 'off') setDemo(false); } catch { /* private mode */ }
    const read = () => { const h = location.hash.slice(1); if (isTab(h)) setTabState(h); };
    read();
    addEventListener('hashchange', read);
    return () => removeEventListener('hashchange', read);
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    const q = new URLSearchParams(location.search);
    if (q.has('tab')) q.set('tab', t);
    const search = q.toString() ? `?${q}` : '';
    history.replaceState(null, '', `${location.pathname}${search}${q.has('tab') || t === 'orders' ? '' : `#${t}`}`);
  };
  const [watch, setWatch] = useState<Address[]>([]);
  const [add, setAdd] = useState('');
  const [data, setData] = useState<{ orders: OrderRow[]; subs: SubRow[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [refunding, setRefunding] = useState<{ id: Hex; amount: string } | null>(null);
  const [hooks, setHooks] = useState<{ items: Delivery[]; note?: string } | null | 'error'>(null);
  const [agents, setAgents] = useState<Settlement[] | null | 'error'>(null);

  useEffect(() => { try { setWatch(JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]')); } catch { /* none */ } }, []);
  const ready = !company.status || company.status === 'ready';
  const demoAccounts = demo ? DEMO_MERCHANTS.map((d) => d.account) : [];
  const own: Address[] = [...(linked ? [linked] : []), ...(ready ? [company.account, ...company.aliases] : [])];
  const merchants: Address[] = [...new Map([...own, ...watch, ...demoAccounts].map((a) => [a.toLowerCase(), a])).values()];
  const ownSet = new Set(own.map((a) => a.toLowerCase()));
  const toggleDemo = () => { const next = !demo; setDemo(next); try { localStorage.setItem(DEMO_KEY, next ? 'on' : 'off'); } catch { /* storage full */ } };

  const load = useCallback(async () => {
    if (!checkout) return;
    setError('');
    try {
      setData(merchantView(decodeCheckoutLogs(await allCheckoutLogs(8)), merchants));
    } catch (e) {
      setError(msg(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout, merchants.join(',')]);
  useEffect(() => { void load(); }, [load]);
  // a linked ?order= that the explorer has not indexed yet: read again every 5 s until it shows
  const focusFound = !!focus && !!data?.orders.some((o) => o.id.toLowerCase() === focus);
  useEffect(() => {
    if (!focus || focusFound) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [focus, focusFound, load]);
  useEffect(() => { if (focusFound) document.querySelector('[data-focus="true"]')?.scrollIntoView({ block: 'center' }); }, [focusFound]);

  // the merchant webhooks are tested for: a linked ?merchant= first, else the selected company
  const merchant = linked ?? (ready ? company.account : null);
  const hookMerchants = [...new Set([...(merchant ? [merchant] : []), ...demoAccounts])];
  const payTos = [...new Set([...(merchant ? [merchant] : []), ...(demo ? [DEMO_PAYTO] : [])])];
  useEffect(() => {
    if (!relayer) return;
    // each address is asked separately; the tab errors only when every request fails
    const gather = async <T,>(urls: string[], pick: (j: Record<string, unknown>) => T[]) => {
      const parts = await Promise.allSettled(urls.map((u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))));
      if (parts.every((p) => p.status === 'rejected')) throw new Error('relayer did not answer');
      const ok = parts.filter((p): p is PromiseFulfilledResult<Record<string, unknown>> => p.status === 'fulfilled').map((p) => p.value);
      return { items: ok.flatMap(pick), note: ok.find((j) => typeof j.note === 'string')?.note as string | undefined };
    };
    const byId = <T extends { id: string; created: number | string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()].sort((a, b) => asMs(b.created) - asMs(a.created));
    if (tab === 'webhooks' && hookMerchants.length) {
      setHooks(null);
      gather(hookMerchants.map((m) => `${relayer}/webhooks/recent?merchant=${m}`), (j) => ((j.items ?? j.deliveries ?? []) as Delivery[]))
        .then(({ items, note }) => setHooks({ items: byId(items), note })).catch(() => setHooks('error'));
    }
    if (tab === 'agents' && payTos.length) {
      setAgents(null);
      gather(payTos.map((m) => `${relayer}/x402/settlements?payTo=${m}`), (j) => ((j.items ?? []) as Settlement[]))
        .then(({ items }) => setAgents(byId(items))).catch(() => setAgents('error'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, relayer, hookMerchants.join(','), payTos.join(',')]);

  const onWatch = () => {
    if (!isAddress(add.trim())) return toast('Enter a merchant address (0x…)', 'error');
    const next = [...new Set([...watch, getAddress(add.trim())])];
    setWatch(next); setAdd('');
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(next)); } catch { /* storage full */ }
  };

  /** The merchant's browser wallet signs; the relayer submits (gasless for the merchant). */
  const withWallet = async (who: Address, fn: (wallet: Awaited<ReturnType<typeof walletSigner>>) => Promise<unknown>) => {
    const eth = injected();
    if (!eth) throw new Error('Open this page in a browser with a wallet (for example MetaMask) that holds the merchant key.');
    const wallet = await walletSigner(eth as never);
    if (wallet.address.toLowerCase() !== who.toLowerCase()) throw new Error(`Your wallet is ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}; switch to the merchant ${who.slice(0, 6)}…${who.slice(-4)} to sign.`);
    return fn(wallet);
  };
  const act = (key: string, fn: () => Promise<unknown>, done: string) => async () => {
    setBusy(key);
    try { await fn(); toast(done); await load(); } catch (e) { toast(msg(e), 'error'); } finally { setBusy(''); }
  };
  const opts = { relayer };

  const header = <PageHeader title="Checkout" subtitle="Gasless card-style payments in USDT for any wallet: orders, refunds, subscriptions, webhooks and AI agents." />;
  if (!checkout) return <div className="page">{header}<Notice testId="co-not-configured">Checkout is not deployed in this build yet.</Notice></div>;

  const orders = data?.orders ?? [];
  const subs = data?.subs ?? [];
  const now = Date.now();

  return (
    <div className="page tz-touch">
      <Toasts />
      {header}
      <Card flush testId="co">
        <div className="tabs co-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} data-testid={`co-tab-${t.id}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'orders' && data && <span className="tab-count">{orders.length}</span>}
              {t.id === 'subscriptions' && data && <span className="tab-count">{subs.length}</span>}
            </button>
          ))}
        </div>
        <div style={{ padding: '12px var(--card-pad) 0' }} className="stack">
          <p className="small muted" style={{ margin: 0 }} data-testid="co-scope">
            {merchant ? <>Showing payments to <b>{linked ? (nameOf(linked) ?? demoName(linked) ?? `${linked.slice(0, 6)}…${linked.slice(-4)}`) : company.name}</b>{watch.length ? ` and ${watch.length} more address${watch.length === 1 ? '' : 'es'}` : ''}{demo ? ', plus the live demo merchants' : ''}. </> : 'Loading the company from ENS… '}
            Read from Whitechain.
          </p>
          <div className="co-demo">
            <button type="button" className="co-chip" aria-pressed={demo} data-testid="co-demo-toggle" onClick={toggleDemo}>{demo ? '✓ ' : ''}Show demo merchants</button>
            {demo && <span className="small muted">{DEMO_MERCHANTS.map((d) => d.name).join(' and ')}{tab === 'agents' ? ', and the demo AI resource' : ''}: real orders on Whitechain Sepolia.</span>}
          </div>
          {(tab === 'orders' || tab === 'subscriptions') && (
            <div className="co-form">
              <input className="input mono" data-testid="co-watch" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Another merchant address (0x…)" aria-label="Another merchant address" />
              <button type="button" className="btn" data-testid="co-watch-add" onClick={onWatch}>Show its payments too</button>
            </div>
          )}
          {error && <Notice tone="negative" testId="co-error">Whitechain&apos;s explorer could not be read: {error}</Notice>}
        </div>

        {tab === 'orders' && (data === null && !error ? <p className="muted" style={{ padding: 'var(--card-pad)' }}>Reading orders…</p> : orders.length === 0 ? (
          <div style={{ padding: 'var(--card-pad)' }}><Empty><span data-testid="co-orders-empty">No checkout orders paid to these addresses yet.</span></Empty></div>
        ) : (
          <div className="table-wrap"><table className="table table-stack co-orders" data-testid="co-orders">
            <thead><tr><th>Order</th><th>Customer</th><th className="num">Amount</th><th className="num">Refunded</th><th>Status</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => {
                const left = o.amount - o.refunded;
                const status = o.refunded === 0n ? 'Paid' : left === 0n ? 'Refunded' : 'Partly refunded';
                return (
                  <tr key={o.id} data-testid="co-order-row" data-focus={o.id.toLowerCase() === focus ? 'true' : undefined}>
                    <td>{shortRef(o.id)}{o.id.toLowerCase() === focus && <> <Pill tone="info" testId="co-order-focus">This order</Pill></>}<span className="cell-sub">{when(o.paidAt)}</span>
                      {!ownSet.has(o.merchant.toLowerCase()) && <span className="cell-sub" data-testid="co-order-merchant">to {nameOf(o.merchant) ?? demoName(o.merchant) ?? `${o.merchant.slice(0, 6)}…${o.merchant.slice(-4)}`}</span>}</td>
                    <td>{o.method === 'signed' && nameOf(o.payer) && <b>{nameOf(o.payer)} </b>}<AddrChip value={o.payer} href={`${config.explorer}/address/${o.payer}`} />
                      <span className="cell-sub" data-testid="co-order-method">{methodLabel(o.method)}{o.method === 'transfer' ? ' (deposit address)' : ''}</span></td>
                    <td className="num">{usdtText(o.amount)}<span className="cell-sub"><Inr v={o.amount} /></span>{o.returned > 0n && <span className="cell-sub" data-testid="co-order-returned">{usdtText(o.returned)} extra sent back</span>}</td>
                    <td className="num">{o.refunded > 0n ? usdtText(o.refunded) : <span className="faint">—</span>}</td>
                    <td><Pill tone={status === 'Paid' ? 'positive' : status === 'Refunded' ? 'neutral' : 'warning'} testId="co-order-status">{status}</Pill></td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <a className="btn btn-sm" href={`/receipt/?order=${o.id}`} data-testid="co-receipt">Receipt</a>
                        {left > 0n && <button type="button" className="btn btn-sm" data-testid="co-refund" onClick={() => setRefunding({ id: o.id, amount: (Number(left) / 1e6).toString() })}>Refund</button>}
                      </span>
                      {refunding?.id === o.id && (
                        <span className="co-inline">
                          <span className="input-affix">
                            <input className="input num" data-testid="co-refund-amount" inputMode="decimal" value={refunding.amount} onChange={(e) => setRefunding({ ...refunding, amount: e.target.value })} aria-label="Refund amount" />
                            <span>USDT</span>
                          </span>
                          <span className="small muted">Goes back to the customer only. Your wallet signs (Face ID, fingerprint or your wallet&apos;s unlock); Tazor pays the gas.</span>
                          <span className="row" style={{ gap: 6 }}>
                            <button type="button" className="btn btn-sm btn-primary" data-testid="co-refund-confirm" disabled={!!busy}
                              onClick={act(`refund-${o.id}`, async () => {
                                const amount = parseUsdt(refunding.amount);
                                if (!amount || amount > left) throw new Error(`Enter an amount up to ${usdtText(left)}.`);
                                await withWallet(o.merchant, (wallet) => refundOrder({ id: o.id, amount, wallet, method: o.method, ...opts }));
                                setRefunding(null);
                              }, 'Refund sent to the customer')}>{busy === `refund-${o.id}` ? 'Refunding…' : 'Refund'}</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRefunding(null)}>Cancel</button>
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        ))}

        {tab === 'subscriptions' && (data === null && !error ? <p className="muted" style={{ padding: 'var(--card-pad)' }}>Reading subscriptions…</p> : subs.length === 0 ? (
          <div style={{ padding: 'var(--card-pad)' }}><Empty><span data-testid="co-subs-empty">No subscriptions to these addresses yet.</span></Empty></div>
        ) : (
          <div className="table-wrap"><table className="table table-stack" data-testid="co-subs">
            <thead><tr><th>Customer</th><th className="num">Plan</th><th>Charged</th><th>Next charge</th><th /></tr></thead>
            <tbody>
              {subs.map((s) => {
                const next = nextCharge(s);
                const due = next !== null && next <= now;
                return (
                  <tr key={s.id} data-testid="co-sub-row">
                    <td>{nameOf(s.payer) && <b>{nameOf(s.payer)} </b>}<AddrChip value={s.payer} /><span className="cell-sub">since {when(s.started)}</span>
                      {!ownSet.has(s.merchant.toLowerCase()) && <span className="cell-sub" data-testid="co-sub-merchant">to {nameOf(s.merchant) ?? demoName(s.merchant) ?? `${s.merchant.slice(0, 6)}…${s.merchant.slice(-4)}`}</span>}</td>
                    <td className="num">{usdtText(s.amount)}<span className="cell-sub">every {every(s.period)}</span></td>
                    <td>{s.charged} of {s.cycles}</td>
                    <td data-testid="co-sub-next">{s.cancelled ? <Pill>Cancelled</Pill> : next === null ? <Pill tone="positive">Finished</Pill> : due ? <Pill tone="warning">Due now</Pill> : when(next)}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        {due && <button type="button" className="btn btn-sm" data-testid="co-charge" disabled={!!busy}
                          onClick={act(`charge-${s.id}`, () => chargeSubscription({ id: s.id, ...opts }), 'Charged')}>{busy === `charge-${s.id}` ? 'Charging…' : 'Charge now'}</button>}
                        {!s.cancelled && next !== null && <button type="button" className="btn btn-sm btn-ghost" data-testid="co-cancel" disabled={!!busy}
                          onClick={act(`cancel-${s.id}`, () => withWallet(s.merchant, (wallet) => cancelSubscription({ id: s.id, wallet, ...opts })), 'Subscription cancelled')}>Cancel</button>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        ))}

        {tab === 'webhooks' && (
          <div className="stack" style={{ padding: 'var(--card-pad)' }}>
            {!relayer ? <Notice testId="co-no-relayer">No relayer is set on this device (Security &amp; settings), so webhook deliveries can&apos;t be listed.</Notice>
              : hooks === null ? <p className="muted">Reading recent deliveries…</p>
                : hooks === 'error' ? <Notice tone="warning" testId="co-hooks-error">The relayer did not answer; webhooks are listed by the relayer that delivers them.</Notice>
                  : hooks.items.length === 0 ? <Empty><span data-testid="co-hooks-empty">No webhook deliveries yet for these merchants.</span></Empty>
                    : (
                      <div className="table-wrap"><table className="table table-stack" data-testid="co-hooks">
                        <thead><tr><th>Event</th><th>When</th><th>Delivery</th><th>Transaction</th></tr></thead>
                        <tbody>{hooks.items.map((h) => (
                          <tr key={h.id} data-testid="co-hook-row">
                            <td><code>{h.type}</code></td>
                            <td>{when(asMs(h.created))}</td>
                            <td><Pill tone={h.status === 'delivered' ? 'positive' : h.status === 'failed' ? 'negative' : 'neutral'}>{h.status === 'no-endpoint' ? 'No endpoint' : h.status === 'delivered' ? 'Delivered' : h.status === 'signed' ? 'Signed, not sent' : 'Failed'}</Pill>
                              <span className="cell-sub">{h.attempts} attempt{h.attempts === 1 ? '' : 's'}{h.httpStatus ? ` · HTTP ${h.httpStatus}` : ''}</span></td>
                            <td>{h.txHash ? <a href={`${config.explorer}/tx/${h.txHash}`} target="_blank" rel="noreferrer">View transaction</a> : <span className="faint">—</span>}</td>
                          </tr>
                        ))}</tbody>
                      </table></div>
                    )}
            {typeof hooks === 'object' && hooks?.note && <p className="small muted" style={{ margin: 0 }}>{hooks.note}</p>}
            {relayer && merchant && (
              <div className="row">
                <button type="button" className="btn" data-testid="co-hook-test" disabled={!!busy} onClick={act('hook-test', async () => {
                  const r = await fetch(`${relayer}/webhooks/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merchant }) });
                  if (r.status === 404) throw new Error('No webhook endpoint is configured for this merchant yet.');
                  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `relayer returned ${r.status}`);
                }, 'Test event sent')}>Send test event</button>
              </div>
            )}
            <h3 className="drawer-h" style={{ marginTop: 8 }}>Verifying a webhook</h3>
            <p className="small muted" style={{ margin: 0 }}>
              Every delivery carries <code>Tazor-Signature: t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256&gt;</code> over <code>t + &quot;.&quot; + raw body</code> with your endpoint secret.
              Reject it if the signature differs or the time is more than 5 minutes away. Events: order.paid, order.refunded, order.finality, subscription.created / charged / cancelled / due, x402.settled.
            </p>
            <pre className="co-code" data-testid="co-hook-verify">{`import { createHmac, timingSafeEqual } from 'node:crypto';
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const ok = Math.abs(Date.now() / 1000 - Number(t)) <= 300 &&
  timingSafeEqual(Buffer.from(v1, 'hex'), createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest());`}</pre>
          </div>
        )}

        {tab === 'agents' && (
          <div className="stack" style={{ padding: 'var(--card-pad)' }}>
            <p className="small muted" style={{ margin: 0 }}>AI agents pay per request with x402: they sign one USDT transfer for the price your API asks, and Tazor&apos;s facilitator settles it on Whitechain.</p>
            {!relayer ? <Notice>No relayer is set on this device, so agent payments can&apos;t be listed.</Notice>
              : agents === null ? <p className="muted">Reading agent payments…</p>
                : agents === 'error' ? <Notice tone="warning" testId="co-agents-error">The relayer did not answer.</Notice>
                  : agents.length === 0 ? <Empty><span data-testid="co-agents-empty">No agent payments to these addresses yet.</span></Empty>
                    : (
                      <div className="table-wrap"><table className="table table-stack" data-testid="co-agents">
                        <thead><tr><th>Agent</th><th>Resource</th><th className="num">Amount</th><th>When</th><th>Transaction</th></tr></thead>
                        <tbody>{agents.map((a) => (
                          <tr key={a.id} data-testid="co-agent-row">
                            <td><AddrChip value={a.payer} /></td>
                            <td className="break">{a.resource}</td>
                            <td className="num">{(() => { try { return usdtText(BigInt(a.amount)); } catch { return '—'; } })()}</td>
                            <td>{when(asMs(a.created))}</td>
                            <td><a href={`${config.explorer}/tx/${a.txHash}`} target="_blank" rel="noreferrer">View transaction</a></td>
                          </tr>
                        ))}</tbody>
                      </table></div>
                    )}
            <p className="small"><a href="/docs/agents-x402/">How agents pay (x402)</a></p>
          </div>
        )}
      </Card>
    </div>
  );
}
