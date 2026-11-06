'use client';

import { useState, type ReactNode } from 'react';

type Tone = 'positive' | 'negative' | 'warning' | 'info' | 'neutral';

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, subtitle, actions, flush, children, className, testId }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; flush?: boolean; children?: ReactNode; className?: string; testId?: string;
}) {
  return (
    <section className={['card', flush ? 'card-flush' : '', className ?? ''].join(' ').trim()} data-testid={testId}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ tone = 'neutral', dot, children, testId }: { tone?: Tone; dot?: boolean; children: ReactNode; testId?: string }) {
  return (
    <span className={`pill${tone === 'neutral' ? '' : ` pill-${tone}`}`} data-testid={testId}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Notice({ tone = 'neutral', children, testId }: { tone?: Tone; children: ReactNode; testId?: string }) {
  return <div className={`notice${tone === 'neutral' ? '' : ` notice-${tone}`}`} role={tone === 'negative' ? 'alert' : undefined} data-testid={testId}>{children}</div>;
}

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export type Kpi = { label: ReactNode; value: ReactNode; unit?: ReactNode; sub?: ReactNode; lead?: boolean; zero?: boolean; testId?: string };

export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="card card-flush">
      <div className="kpis">
        {items.map((k, i) => (
          <div key={i} className={`kpi${k.lead ? ' lead-cell' : ''}`}>
            <div className="kpi-label">{k.label}</div>
            <div className={`kpi-value${k.lead ? ' lead' : ''}${k.zero ? ' zero' : ''}`} data-testid={k.testId}>
              {k.value}{k.unit && <span className="kpi-unit">{k.unit}</span>}
            </div>
            {k.sub && <div className="kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const short = (v: string, head = 6, tail = 4) => (v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v);

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => { navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {}); }}
    >
      {done
        ? <svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" /></svg>
        : <svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="2" /><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" /></svg>}
    </button>
  );
}

/** An address, hash or ID: mono, truncated, with copy and an optional explorer link. */
export function Addr({ value, href, full, testId }: { value: string; href?: string; full?: boolean; testId?: string }) {
  const text = full ? value : short(value);
  return (
    <span className="addr" title={value}>
      {href ? <a href={href} target="_blank" rel="noreferrer" data-testid={testId}>{text}</a> : <span data-testid={testId}>{text}</span>}
      <CopyButton value={value} />
    </span>
  );
}

export const usdt = (v: number | bigint | string, decimals = 2) => {
  const n = typeof v === 'number' ? v : Number(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

export { short };
