'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { config } from '@/lib/config.ts';
import {
  allCheckoutLogs, checkoutAddress, checkoutLedger, checkoutMerchants, decodeCheckoutLogs, demoOn, depositCheckoutAddress, ledgerTotals,
  loadWatch, merchantView, methodLabel, setDemoOn, shortRef, toCheckoutCsv, type LedgerRow,
} from '@/lib/checkout.ts';
import { companyByAccount, useCompany } from '@/lib/company.ts';
import { ensLabelOf } from '@/lib/ens-directory.ts';
import { usdtText } from '@/lib/money.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Card, Empty, Notice } from '../_ui/index.tsx';
import './checkout.css';

const SHOWN = 25;
const nameOf = (a: string) => companyByAccount(a)?.name ?? ensLabelOf(a) ?? null;
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export function downloadCsv(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reports: Checkout payments and refunds as accountant rows (date, customer, order, gross, refund, net, transaction), with a CSV. */
export function CheckoutLedger() {
  const company = useCompany();
  const ready = !company.status || company.status === 'ready';
  const [linked, setLinked] = useState<Address | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [watch, setWatch] = useState<Address[]>([]);
  const [demo, setDemo] = useState(true);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const m = q.get('merchant')?.trim() ?? '';
    if (isAddress(m)) setLinked(getAddress(m));
    const o = q.get('order')?.trim().toLowerCase() ?? '';
    if (/^0x[0-9a-f]{64}$/.test(o)) setFocus(o);
    setWatch(loadWatch());
    setDemo(demoOn());
  }, []);

  const own: Address[] = [...(linked ? [linked] : []), ...(ready ? [company.account, ...company.aliases] : [])];
  const merchants = checkoutMerchants({ own, watch, demo });
  const key = merchants.join(',');
  const load = useCallback(async () => {
    try {
      setRows(checkoutLedger(merchantView(decodeCheckoutLogs(await allCheckoutLogs(8)), merchants).orders));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { void load(); }, [load]);

  // a linked ?order= whose refund the explorer has not indexed yet: read again every 5 s (up to 2 minutes)
  const isFocus = (r: LedgerRow) => !!focus && r.order.toLowerCase() === focus;
  const focusDone = !!rows?.some((r) => isFocus(r) && r.type === 'Refund');
  useEffect(() => {
    if (!focus || focusDone) return;
    let n = 0;
    const t = setInterval(() => { if (++n > 24) clearInterval(t); else void load(); }, 5000);
    return () => clearInterval(t);
  }, [focus, focusDone, load]);
  useEffect(() => { if (rows?.some(isFocus)) document.querySelector('[data-ck-focus="true"]')?.scrollIntoView({ block: 'center' }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rows?.length, focusDone]);

  if (!checkoutAddress() && !depositCheckoutAddress()) return null;
  const toggleDemo = () => { const next = !demo; setDemo(next); setDemoOn(next); };
  const newestFirst = [...(rows ?? [])].reverse();
  const focused = newestFirst.filter(isFocus);
  const shown = [...focused, ...newestFirst.filter((r) => !isFocus(r)).slice(0, Math.max(0, SHOWN - focused.length))];
  const t = ledgerTotals(rows ?? []);
  const who = linked ? (nameOf(linked) ?? `${linked.slice(0, 6)}…${linked.slice(-4)}`) : company.name;

  return (
    <div id="checkout" data-testid="ck">
      <Card title="Checkout sales" subtitle="Every Checkout payment and refund, read from Whitechain, one row each: ready for your accountant." flush>
        <div className="stack" style={{ padding: '0 var(--card-pad) 12px' }}>
          <p className="small muted" style={{ margin: 0 }} data-testid="ck-scope">
            Payments to <b>{who}</b>{watch.length ? ` and ${watch.length} more address${watch.length === 1 ? '' : 'es'}` : ''}{demo ? ', plus the live demo merchants' : ''}. Same addresses as the Checkout page.
          </p>
          <div className="co-demo">
            <button type="button" className="co-chip" aria-pressed={demo} data-testid="ck-demo-toggle" onClick={toggleDemo}>{demo ? '✓ ' : ''}Show demo merchants</button>
            <button type="button" className="btn btn-primary" data-testid="ck-csv" disabled={!rows?.length}
              onClick={() => downloadCsv(`tazor-checkout-${new Date().toISOString().slice(0, 10)}.csv`, toCheckoutCsv(rows ?? []))}>Download CSV</button>
          </div>
          {error && <Notice tone="negative" testId="ck-error">Whitechain&apos;s explorer could not be read: {error}</Notice>}
        </div>
        {rows === null && !error ? <p className="muted" style={{ padding: '0 var(--card-pad) var(--card-pad)' }}>Reading Checkout payments…</p>
          : !rows?.length ? <div style={{ padding: '0 var(--card-pad) var(--card-pad)' }}><Empty><span data-testid="ck-empty">No Checkout payments to these addresses yet.</span></Empty></div>
            : (
              <div className="table-wrap"><table className="table table-stack ck-table" data-testid="ck-ledger">
                <thead><tr><th>Date</th><th>Customer</th><th>Order</th><th className="num">Gross</th><th className="num">Refund</th><th className="num">Net</th><th>Transaction</th></tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const f = isFocus(r);
                    return (
                      <tr key={`${r.tx}-${r.type}-${r.order}`} data-row="ck" data-type={r.type} data-ck-focus={f ? 'true' : undefined}
                        data-testid={f ? (r.type === 'Payment' ? 'ck-focus-payment' : 'ck-focus-refund') : 'ck-row'}>
                        <td>{day(r.at)}<span className="cell-sub">{r.type === 'Payment' ? 'Payment' : 'Refund'} · {methodLabel(r.method)}</span></td>
                        <td>{r.method === 'signed' && nameOf(r.customer) && <b>{nameOf(r.customer)} </b>}<AddrChip value={r.customer} href={`${config.explorer}/address/${r.customer}`} /></td>
                        <td><a href={`/receipt/?order=${r.order}`}>{shortRef(r.order)}</a></td>
                        <td className="num" data-label="Gross">{r.gross ? usdtText(r.gross) : <span className="faint">—</span>}</td>
                        <td className="num" data-label="Refund">{r.refund ? usdtText(r.refund) : <span className="faint">—</span>}</td>
                        <td className="num" data-label="Net"><b>{r.net < 0n ? `−${usdtText(-r.net)}` : usdtText(r.net)}</b></td>
                        <td><a href={`${config.explorer}/tx/${r.tx}`} target="_blank" rel="noreferrer">View transaction</a></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr data-testid="ck-totals">
                  <td colSpan={3}><b>Total</b><span className="cell-sub">{rows.length} row{rows.length === 1 ? '' : 's'}{rows.length > shown.length ? ` · showing ${shown.length}; the CSV has all` : ''}</span></td>
                  <td className="num" data-label="Gross">{usdtText(t.gross)}</td><td className="num" data-label="Refunds">{usdtText(t.refund)}</td><td className="num" data-label="Net"><b>{usdtText(t.net)}</b></td><td />
                </tr></tfoot>
              </table></div>
            )}
      </Card>
    </div>
  );
}
