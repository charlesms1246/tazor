'use client';

import { useEffect, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { allCheckoutLogs, checkoutMerchants, decodeCheckoutLogs, loadWatch, merchantView, saveWatch, type OrderRow, type SubRow } from '@/lib/checkout.ts';
import { netSales } from '@/lib/checkout-stats.ts';
import { encodeInvoiceLink } from '@/lib/invoice-link.ts';
import { usdtText } from '@/lib/money.ts';
import { checkPayouts, payoutInvoice, payoutPlan, type PayoutRow } from '@/lib/payouts.ts';
import { config } from '@/lib/config.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Card, CopyButton, Field, Notice } from '../_ui/index.tsx';

const PERIODS = { '7': 'Last 7 days', '30': 'Last 30 days', all: 'All time' } as const;
type Period = keyof typeof PERIODS;
const empty = (): PayoutRow => ({ address: '', name: '', amount: '' });
const explorer = (a: string) => `${config.explorer}/address/${a}`;

/**
 * "Buyers pay in, suppliers get paid out": this company's net checkout sales for a period, and supplier payouts that
 * become ordinary invoices in the payment run below (same passkey approval and payRun). It never moves money itself.
 */
export function SupplierPayouts({ company, billsTotal, onAddLinks }: {
  company: { account: Address; aliases: Address[]; name: string; status?: string }; billsTotal: bigint; onAddLinks: (links: string[]) => void;
}) {
  const ready = company.status === undefined || company.status === 'ready';
  const [watch, setWatch] = useState<Address[]>([]);
  const [data, setData] = useState<{ orders: OrderRow[]; subs: SubRow[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [period, setPeriod] = useState<Period>('30');
  const [wallet, setWallet] = useState('');
  const [rows, setRows] = useState<PayoutRow[]>([empty()]);
  const [error, setError] = useState('');
  const [added, setAdded] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => { setWatch(loadWatch()); }, []);
  // sales are read only once the panel is opened
  const merchants = ready && open ? checkoutMerchants({ own: [company.account, ...company.aliases], watch, demo: false }) : [];
  useEffect(() => {
    if (!merchants.length) return;
    let live = true;
    setLoadError('');
    allCheckoutLogs(8)
      .then((logs) => { if (live) setData(merchantView(decodeCheckoutLogs(logs), merchants)); })
      .catch((e) => { if (live) { setData({ orders: [], subs: [] }); setLoadError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchants.join(',')]);

  const since = period === 'all' ? 0 : Date.now() - Number(period) * 86_400_000;
  const sales = data ? netSales(data, since) : null;
  const salesWallets = data ? [...new Set([...data.orders, ...data.subs].map((x) => getAddress(x.merchant)))] : [];
  const check = checkPayouts(rows.filter((r) => r.address || r.name || r.amount));
  const payouts = check.ok ? check.total : 0n;
  const plan = sales ? payoutPlan({ net: sales.net, payouts, bills: billsTotal, company: company.account, salesWallets }) : null;

  const addWallet = () => {
    if (!isAddress(wallet.trim())) return setError('Enter the wallet address your checkout payments go to (0x…).');
    const next = [...new Set([...watch, getAddress(wallet.trim())])];
    saveWatch(next); setWatch(next); setWallet(''); setError('');
  };
  const set = (i: number, k: keyof PayoutRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const addToRun = async () => {
    setError(''); setAdded('');
    const filled = rows.filter((r) => r.address || r.name || r.amount);
    const c = checkPayouts(filled);
    if (!c.ok) return setError(c.error);
    try {
      const links = await Promise.all(filled.map((r, i) => encodeInvoiceLink(payoutInvoice(company.account, r, i + 1), location.origin)));
      onAddLinks(links);
      setAdded(`Added ${links.length} supplier payout${links.length === 1 ? '' : 's'} (${usdtText(c.total)}) to the run below. Check the run, then approve it with your passkey.`);
      setRows([empty()]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card testId="po">
      <details className="tech-details po" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary data-testid="po-open"><b>Pay suppliers from sales</b> <span className="muted small">· buyers pay you through checkout; pay your suppliers out of those sales in one run, with one passkey approval</span></summary>
      <div className="stack" style={{ gap: 16, marginTop: 12 }}>
        <div className="row" style={{ gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <select className="select" data-testid="po-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Period" style={{ width: 'auto' }}>
            {(Object.keys(PERIODS) as Period[]).map((p) => <option key={p} value={p}>{PERIODS[p]}</option>)}
          </select>
          {!ready || data === null ? <span className="muted">Reading sales…</span> : (
            <span data-testid="po-net" data-net={sales!.net.toString()}>
              Net checkout sales: <b>{usdtText(sales!.net)}</b> <span className="muted small">({usdtText(sales!.gross)} in, {usdtText(sales!.refunds)} refunded, {sales!.payments} payment{sales!.payments === 1 ? '' : 's'})</span>
            </span>
          )}
        </div>
        {loadError && <Notice tone="warning">Sales could not be read from Whitechain&apos;s explorer right now; you can still add payouts.</Notice>}

        {plan?.topUpNeeded && (
          <Notice tone="info" testId="po-topup">
            <span className="stack" style={{ gap: 6 }}>
              <span>Sales arrive in {plan.salesWallets.map((w) => <AddrChip key={w} value={w} href={explorer(w)} />)}; payouts go from {company.name}&apos;s account <AddrChip value={company.account} href={explorer(company.account)} />.</span>
              <span>Top up the company account from sales first: send USDT from the sales wallet to the company account. <CopyButton value={company.account} label="Copy company address" /></span>
            </span>
          </Notice>
        )}
        {data !== null && salesWallets.length === 0 && (
          <Field label="Your sales wallet" hint="The address your checkout or payment-link payments go to (also shown on Checkout).">
            <div className="input-group">
              <input className="input mono" data-testid="po-wallet" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" />
              <button type="button" className="btn" data-testid="po-wallet-add" onClick={addWallet}>Use it</button>
            </div>
          </Field>
        )}

        <div className="stack" style={{ gap: 10 }} data-testid="po-rows">
          {rows.map((r, i) => (
            <div key={i} className="po-row" data-testid="po-row">
              <input className="input mono" data-testid="po-address" aria-label={`Supplier ${i + 1} address`} value={r.address} onChange={(e) => set(i, 'address', e.target.value)} placeholder="Supplier address (0x…)" />
              <input className="input" data-testid="po-name" aria-label={`Supplier ${i + 1} name`} value={r.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Name" />
              <div className="input-affix">
                <input className="input num" style={{ textAlign: 'right' }} inputMode="decimal" data-testid="po-amount" aria-label={`Supplier ${i + 1} amount`} value={r.amount} onChange={(e) => set(i, 'amount', e.target.value)} placeholder="0.00" />
                <span>USDT</span>
              </div>
              {rows.length > 1 && <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove supplier ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          ))}
          <div><button type="button" className="btn btn-sm" data-testid="po-add-row" onClick={() => setRows((rs) => [...rs, empty()])}>Add another supplier</button></div>
        </div>

        {plan && (
          <p className="small" data-testid="po-plan" style={{ margin: 0 }}>
            Payouts {usdtText(payouts)}{billsTotal > 0n ? ` + selected bills ${usdtText(billsTotal)}` : ''} = <b>{usdtText(plan.planned)}</b> of {usdtText(sales!.net)} net sales
            {plan.overSales ? <span className="error-text" data-testid="po-over"> · more than this period&apos;s net sales</span> : <span className="muted"> · {usdtText(plan.left)} left</span>}
          </p>
        )}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" data-testid="po-add-to-run" onClick={() => void addToRun()}>Add to the payment run</button>
          <span className="small muted">New suppliers must be allowed payees of a v2 company account first (Policies).</span>
        </div>
        {error && <Notice tone="negative" testId="po-error">{error}</Notice>}
        {added && <Notice tone="positive" testId="po-added">{added}</Notice>}
      </div>
      </details>
    </Card>
  );
}
