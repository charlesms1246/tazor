'use client';

import { config } from '@/lib/config.ts';
import { CHANNEL_LABEL, salesStats, type Channel } from '@/lib/checkout-stats.ts';
import type { OrderRow, SubRow } from '@/lib/checkout.ts';
import { usdtNumber, usdtText } from '@/lib/money.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Empty, KpiStrip } from '../_ui/index.tsx';

const W = 640;
const H = 180;
const L = 44;
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

/** Net sales per day: bars above the line are sales, below are days where refunds exceeded sales. */
function DailyChart({ daily }: { daily: { day: string; net: bigint }[] }) {
  const max = daily.reduce((m, d) => (d.net > m ? d.net : -d.net > m ? -d.net : m), 0n);
  const top = max === 0n ? 1_000_000n : max;
  const anyNeg = daily.some((d) => d.net < 0n);
  const plotH = H - 30;
  const mid = anyNeg ? 6 + plotH / 2 : 6 + plotH;
  const span = anyNeg ? plotH / 2 : plotH;
  const step = (W - L - 8) / daily.length;
  const bw = Math.max(4, step * 0.6);
  const h = (v: bigint) => (Number((v < 0n ? -v : v) * 1000n / top) / 1000) * span;
  return (
    <svg className="flow-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Net sales per day, last 14 days" data-testid="ov-chart">
      <line x1={L} x2={W - 8} y1={mid} y2={mid} className="axis" />
      <line x1={L} x2={W - 8} y1={mid - span} y2={mid - span} className="grid" />
      <text x={L - 8} y={mid - span + 4} textAnchor="end" className="tick">{usdtNumber(top)}</text>
      <text x={L - 8} y={mid + 4} textAnchor="end" className="tick">0</text>
      {daily.map((d, i) => {
        const x = L + i * step + (step - bw) / 2;
        return (
          <g key={d.day} data-testid="ov-day" data-day={d.day} data-net={d.net.toString()}>
            {d.net > 0n && <rect x={x} y={mid - h(d.net)} width={bw} height={Math.max(1, h(d.net))} className="bar-in"><title>{`${d.day}: ${usdtText(d.net)}`}</title></rect>}
            {d.net < 0n && <rect x={x} y={mid} width={bw} height={Math.max(1, h(d.net))} className="bar-out"><title>{`${d.day}: ${usdtText(d.net)}`}</title></rect>}
            {(i % 2 === 0 || i === daily.length - 1) && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="tick">{new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Merchant analytics from the same on-chain orders and subscriptions the other tabs show. */
export function Overview({ orders, subs, loading, nameOf }: { orders: OrderRow[]; subs: SubRow[]; loading: boolean; nameOf: (a: string) => string | null }) {
  if (loading) return <p className="muted" style={{ padding: 'var(--card-pad)' }}>Reading sales…</p>;
  if (orders.length === 0 && subs.length === 0) {
    return <div style={{ padding: 'var(--card-pad)' }}><Empty><span data-testid="ov-empty">No sales to these addresses yet. Share a payment link or add the button to your shop.</span></Empty></div>;
  }
  const s = salesStats({ orders, subs });
  const channels: Channel[] = ['wallet', 'transfer', 'subscription'];
  return (
    <div className="stack ov" style={{ padding: 'var(--card-pad)', gap: 20 }} data-testid="ov">
      <KpiStrip items={[
        { label: 'Net sales', value: usdtNumber(s.net), unit: 'USDT', lead: true, testId: 'ov-net', sub: `${usdtText(s.gross)} in, ${usdtText(s.refunds)} refunded` },
        { label: 'Payments', value: String(s.payments), testId: 'ov-payments', sub: `${s.orders} order${s.orders === 1 ? '' : 's'}, ${s.charges} subscription charge${s.charges === 1 ? '' : 's'}` },
        { label: 'Average payment', value: usdtNumber(s.average), unit: 'USDT', testId: 'ov-average' },
        { label: 'Repeat customers', value: String(s.repeatCustomers), testId: 'ov-repeat', sub: `of ${s.customers} customer${s.customers === 1 ? '' : 's'} paid twice or more` },
        { label: 'Refund rate', value: pct(s.refundRate), testId: 'ov-refund-rate', sub: 'refunded ÷ received', zero: s.refundRate === 0 },
      ]} />

      <section>
        <h3 className="ov-h">Net sales, last 14 days</h3>
        <DailyChart daily={s.daily} />
        <p className="small muted">By the day the payment (or refund) landed on Whitechain, in UTC.</p>
      </section>

      <div className="ov-cols">
        <section>
          <h3 className="ov-h">Paid with</h3>
          <ul className="ov-mix" data-testid="ov-mix">
            {channels.map((c) => {
              const share = s.gross > 0n ? Number((s.byChannel[c].gross * 1000n) / s.gross) / 1000 : 0;
              return (
                <li key={c} data-testid={`ov-mix-${c}`}>
                  <span className="ov-mix-label">{CHANNEL_LABEL[c]}</span>
                  <span className="ov-mix-value">{usdtText(s.byChannel[c].gross)} · {s.byChannel[c].count} payment{s.byChannel[c].count === 1 ? '' : 's'}</span>
                  <div className="progress" aria-hidden="true"><div style={{ width: pct(share), height: '100%', background: 'var(--wc-blue)' }} /></div>
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h3 className="ov-h">Top customers</h3>
          <ol className="ov-top" data-testid="ov-top">
            {s.topCustomers.map((c) => (
              <li key={c.payer} data-testid="ov-top-row">
                <AddrChip value={c.payer} name={nameOf(c.payer)} href={`${config.explorer}/address/${c.payer}`} />
                <span className="ov-top-net">{usdtText(c.net)} <span className="muted small">· {c.payments} payment{c.payments === 1 ? '' : 's'}</span></span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
