'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { COMPANIES, setCompany, useCompany } from '@/lib/company.ts';
import { CommandPalette, openPalette } from '../_cmdk/palette.tsx';
import { Tour } from '../_tour/tour.tsx';
import { AutopilotPanel } from '../_autopilot/panel.tsx';
import { RelayerOffBanner } from '../security/relayer-off.tsx';
import './nav.css';

const ICONS: Record<string, ReactNode> = {
  home: <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5v-4h-3v4H3a.5.5 0 0 1-.5-.5z" />,
  pay: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2 6.5h12M4.5 10h2.5" /></>,
  invoice: <><path d="M4 2h6l2.5 2.5V14H4z" /><path d="M6.5 7.5h4M6.5 10h4M10 2v2.5h2.5" /></>,
  runs: <><path d="M3 4h10M3 8h10M3 12h6" /><path d="m11.5 11 1.5 1.5L15 10" /></>,
  mandate: <><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 2.5V5h-2.5" /><path d="M8 5.5V8l1.5 1.5" /></>,
  me: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2" /></>,
  start: <><circle cx="8" cy="8" r="6" /><path d="M8 5v6M5 8h6" /></>,
  checkout: <><path d="M2.5 3.5h1.5l1.6 7h7l1.4-5H5" /><circle cx="6.5" cy="13" r="1" /><circle cx="11.5" cy="13" r="1" /></>,
  export: <><path d="M8 2.5v7M5 6.5l3 3 3-3" /><path d="M3 11v2.5h10V11" /></>,
  team: <><circle cx="6" cy="5.5" r="2.25" /><path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" /><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4M11.5 9.7c1.3.4 2.2 1.6 2.5 3.3" /></>,
  policy: <><path d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4z" /><path d="m6 8 1.5 1.5L10.5 6.5" /></>,
  onboard: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5.5v5M5.5 8h5" /></>,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6" /></>,
  approvals: <><path d="M2.5 4.5h11v8h-11z" /><path d="m2.5 5 5.5 4 5.5-4" /></>,
  company: <><path d="M2.5 13.5V4l5-2v11.5M7.5 6h6v7.5" /><path d="M2 13.5h12M4.5 6.5h1M4.5 9h1M10 8.5h1M10 11h1" /></>,
  security: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  autopilot: <><path d="M8 1.8 9.6 6.4 14.2 8 9.6 9.6 8 14.2 6.4 9.6 1.8 8 6.4 6.4z" /></>,
  docs: <><path d="M3 2.5h7.5L13 5v8.5H3z" /><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" /></>,
  developers: <><path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5" /></>,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
};

const Icon = ({ name }: { name: string }) => <svg viewBox="0 0 16 16" aria-hidden="true">{ICONS[name]}</svg>;

export function Mark({ size = 32 }: { size?: number }) {
  return <img className="mark" src="/brand/tazor-tile.png" width={size} height={size} alt="" aria-hidden="true" />;
}

export function Wordmark() {
  return <span className="wordmark">tazor</span>;
}

type Item = { href: string; label: string; icon: string; short?: string };
/** Selling first: what a merchant uses every day. */
const MAIN: Item[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/start/', label: 'Start accepting USDT', icon: 'start' },
  { href: '/checkout/', label: 'Checkout', icon: 'checkout' },
  { href: '/export/', label: 'Reports', icon: 'export' },
  { href: '/me/', label: 'My payments (customer)', icon: 'me' },
  { href: '/autopilot/', label: 'Autopilot', icon: 'autopilot' },
];
/** Also built: business-to-business invoices and approvals by verified people. Collapsed by default. */
const B2B: Item[] = [
  { href: '/invoices/', label: 'Invoices', icon: 'invoice' },
  { href: '/mandates/', label: 'Collect', icon: 'mandate' },
  { href: '/approvals/', label: 'Approvals', icon: 'approvals' },
  { href: '/runs/', label: 'Payment runs', icon: 'runs' },
  { href: '/company/', label: 'Company', icon: 'company' },
  { href: '/policies/', label: 'Policies', icon: 'policy' },
];
const FOOT: Item[] = [
  { href: '/onboard/', label: 'Set up my passkey', icon: 'onboard' },
  { href: '/security/', label: 'Security & settings', icon: 'security' },
  { href: '/docs/', label: 'Docs', icon: 'docs' },
];
const BOTTOM: Item[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/checkout/', label: 'Checkout', icon: 'checkout' },
  { href: '/export/', label: 'Reports', icon: 'export' },
  { href: '/start/', label: 'Start', icon: 'start' },
];
const B2B_KEY = 'tazor.nav.b2b.v1';

const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path.startsWith(href));

/** The B2B pages, folded away unless opened (remembered on this device) or one of them is the current page. */
function B2BGroup({ path, link }: { path: string; link: (it: Item) => ReactNode }) {
  const here = B2B.some((it) => isActive(path, it.href));
  const [open, setOpen] = useState(false);
  useEffect(() => { try { setOpen(localStorage.getItem(B2B_KEY) === 'open'); } catch { /* private mode */ } }, []);
  const shown = open || here;
  const toggle = () => { const next = !shown; setOpen(next); try { localStorage.setItem(B2B_KEY, next ? 'open' : 'closed'); } catch { /* storage full */ } };
  return (
    <div className="nav-group">
      <button type="button" className="nav-label nav-toggle" aria-expanded={shown} onClick={toggle} data-testid="nav-b2b">
        <span>B2B: invoices &amp; approvals</span><span className="nav-caret" aria-hidden="true">{shown ? '▾' : '▸'}</span>
      </button>
      {shown && <div data-testid="nav-b2b-items">{B2B.map(link)}</div>}
    </div>
  );
}

function NavLinks({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const link = (it: Item) => (
    <a key={it.href} href={it.href} className="nav-item" aria-current={isActive(path, it.href) ? 'page' : undefined} onClick={onNavigate}>
      <Icon name={it.icon} />{it.label}
    </a>
  );
  return (
    <>
      <nav aria-label="Main">
        {MAIN.map(link)}
        <B2BGroup path={path} link={link} />
      </nav>
      <div className="sidebar-foot">
        {FOOT.map(link)}
      </div>
    </>
  );
}

function Switcher() {
  const company = useCompany();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as Element)?.closest?.('.switcher-wrap')) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="switcher-wrap">
      <button type="button" className="switcher" data-testid="company-switcher" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="switcher-avatar">{company.name.slice(0, 1)}</span>
        <span className="switcher-text">
          <span className="switcher-name">{company.status === 'loading' ? <span className="skeleton" style={{ width: 120 }} /> : company.status === 'error' ? 'ENS unavailable' : company.ens}</span>
          <span className="switcher-sub">{company.role} · Whitechain Sepolia</span>
        </span>
        <svg className="switcher-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" /></svg>
      </button>
      {open && (
        <ul className="switcher-menu" role="listbox" aria-label="Switch company">
          {COMPANIES.map((c) => (
            <li key={c.id}>
              <button type="button" role="option" aria-selected={c.id === company.id} data-testid={`switch-${c.id}`}
                onClick={() => { setCompany(c.id); setOpen(false); }}>
                <span className="switcher-avatar">{c.name.slice(0, 1)}</span>
                <span className="switcher-text">
                  <span className="switcher-name">{c.name}</span>
                  <span className="switcher-sub">{c.ens} · {c.role}</span>
                </span>
                {c.id === company.id && <svg className="switcher-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>}
              </button>
            </li>
          ))}
          <li className="switcher-note">Demo companies: switch to see both sides of a payment.</li>
        </ul>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const raw = usePathname() || '/';
  const path = raw.endsWith('/') ? raw : `${raw}/`;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  return (
    <>
      <div className="testnet-bar" data-testid="testnet-bar" role="note">
        <b>Test mode</b>
        <span>Whitechain Sepolia</span>
        <span className="tb-long">· WB Soul verification is simulated · test USDT only</span>
      </div>
      <RelayerOffBanner />
      <div className="mobile-bar">
        <a href="/" className="brand" aria-label="Tazor home"><Mark size={28} /><Wordmark /></a>
        <span className="row" style={{ gap: 4 }}>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Search" onClick={() => openPalette()}>
          <svg className="icon-16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((o) => !o)}>
          <span className="nav-item" style={{ margin: 0, padding: 0, height: 'auto', color: 'inherit', background: 'none' }}><Icon name={open ? 'close' : 'menu'} /></span>
        </button>
        </span>
      </div>
      <div className="mobile-sheet" data-open={open}>
        <Switcher />
        <NavLinks path={path} onNavigate={() => setOpen(false)} />
      </div>
      <div className="shell">
        <aside className="sidebar">
          <a href="/" className="brand" aria-label="Tazor home"><Mark /><Wordmark /></a>
          <Switcher />
          <button type="button" className="search-btn" data-testid="open-search" onClick={() => openPalette()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
            <span>Search</span><kbd>⌘K</kbd>
          </button>
          <NavLinks path={path} />
          <div className="sidebar-meta">Built on Whitechain · roles on ENS</div>
        </aside>
        <main className="main">{children}</main>
      </div>
      <nav className="bottom-nav" aria-label="Quick">
        {BOTTOM.map((it) => (
          <a key={it.href} href={it.href} aria-current={isActive(path, it.href) ? 'page' : undefined}><Icon name={it.icon} />{it.label}</a>
        ))}
        <a href="#" onClick={(e) => { e.preventDefault(); setOpen(true); window.scrollTo(0, 0); }}><Icon name="menu" />More</a>
      </nav>
      <CommandPalette />
      <Tour />
      <AutopilotPanel />
    </>
  );
}
