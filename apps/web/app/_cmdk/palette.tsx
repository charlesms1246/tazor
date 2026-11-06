'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { COMPANIES, companyByAccount, setCompany, useCompany } from '../../lib/company.ts';
import { loadInvoices } from '../../lib/invoices-store.ts';
import { DOC_GROUPS, docHref } from '../docs/content.ts';
import { startTour } from '../_tour/tour.tsx';
import { flatten, moveIndex, rank, segments, type Command, type Hit } from './match.ts';
import './palette.css';

const OPEN_EVENT = 'tazor:cmdk';

/** Opens the palette from anywhere (for example a search button in the sidebar). */
export function openPalette(): void {
  globalThis.dispatchEvent?.(new Event(OPEN_EVENT));
}

const PAGES: { href: string; title: string; keywords: string[] }[] = [
  { href: '/', title: 'Home', keywords: ['dashboard', 'balance', 'overview'] },
  { href: '/start/', title: 'Start accepting USDT', keywords: ['onboarding', 'merchant', 'pay button', 'payment link', 'snippet', 'setup', 'qr'] },
  { href: '/checkout/', title: 'Checkout', keywords: ['orders', 'refund', 'receipt', 'subscriptions', 'webhooks', 'agents', 'x402', 'sales'] },
  { href: '/export/', title: 'Reports', keywords: ['export', 'csv', 'statement', 'accounting', 'books', 'accountant'] },
  { href: '/autopilot/', title: 'Autopilot', keywords: ['demo', 'story', 'tour', 'walkthrough'] },
  { href: '/invoices/', title: 'Invoices (B2B)', keywords: ['bill', 'send', 'create', 'receive'] },
  { href: '/mandates/', title: 'Collect (B2B)', keywords: ['mandates', 'direct debit', 'recurring'] },
  { href: '/approvals/', title: 'Approvals (B2B)', keywords: ['approve', 'sign', 'passkey', 'pay an invoice', 'scan qr', 'paid'] },
  { href: '/runs/', title: 'Payment runs (B2B)', keywords: ['batch', 'payroll', 'many invoices'] },
  { href: '/company/', title: 'Company (B2B)', keywords: ['ens', 'people', 'team', 'roles', 'profile'] },
  { href: '/policies/', title: 'Policies (B2B)', keywords: ['limits', 'spending', 'rules', 'payees'] },
  { href: '/onboard/', title: 'Approver setup (B2B)', keywords: ['passkey', 'onboarding', 'join', 'add me', 'wb soul'] },
  { href: '/security/', title: 'Security & settings', keywords: ['settings', 'relayer', 'freeze', 'lost device', 'health', 'status', 'revoke', 'contracts'] },
  { href: '/docs/', title: 'Docs', keywords: ['help', 'guide', 'documentation'] },
];

const fmt = (amount: bigint) => (Number(amount) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function buildCommands(companyId: string): Command[] {
  const pages: Command[] = PAGES.map((p) => ({ id: `page:${p.href}`, group: 'Pages', title: p.title, keywords: p.keywords, href: p.href }));
  const actions: Command[] = [
    { id: 'act:create-invoice', group: 'Actions', title: 'Create invoice', keywords: ['new invoice', 'bill'], href: '/invoices/' },
    { id: 'act:open-link', group: 'Actions', title: 'Open a payment link', keywords: ['pay', 'paste', 'scan', 'qr'], href: '/approvals/' },
    // one "Switch to …" per other company in the ENS directory (none while it is still loading)
    ...COMPANIES.filter((c) => c.id && c.id !== companyId).map((o): Command => ({
      id: `act:switch:${o.id}`, group: 'Actions', title: `Switch to ${o.name || o.ens}${o.role ? ` (${o.role.toLowerCase()})` : ''}`, subtitle: o.ens, keywords: ['company', 'switch', o.ens, o.id], action: `switch:${o.id}`,
    })),
    { id: 'act:tour', group: 'Actions', title: 'Take the product tour', keywords: ['tour', 'walkthrough', 'help', 'guide'], action: 'tour' },
  ];
  const invoices: Command[] = loadInvoices().map(({ invoice }) => {
    const buyer = companyByAccount(invoice.buyerAccount);
    const customer = buyer?.name ?? shortAddr(invoice.buyerAccount);
    const amount = fmt(invoice.amount);
    return {
      id: `inv:${invoice.id}`, group: 'Invoices', title: invoice.id,
      subtitle: `${customer} · ${amount} USDT`,
      keywords: [customer, amount, buyer?.ens ?? invoice.buyerAccount, invoice.supplierName],
      href: `/invoices/?open=${encodeURIComponent(invoice.id)}`,
    };
  });
  const docs: Command[] = DOC_GROUPS.flatMap((g) => g.pages.map((p) => ({
    id: `doc:${p.slug}`, group: 'Docs' as const, title: p.title, subtitle: p.summary, keywords: [g.title, p.slug.replace(/-/g, ' ')], href: docHref(p.slug),
  })));
  return [...pages, ...actions, ...invoices, ...docs];
}

function Highlighted({ text, hit }: { text: string; hit: Hit }) {
  return <>{segments(text, hit.ranges).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [cmds, setCmds] = useState<Command[]>([]);
  const [mac, setMac] = useState(true);
  const company = useCompany();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  openRef.current = open;
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const show = useCallback(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    const el = returnFocus.current;
    if (el && document.contains(el)) requestAnimationFrame(() => el.focus());
  }, []);

  useEffect(() => {
    setMac(isMac());
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (openRef.current) hide(); else show();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, show); };
  }, [show, hide]);

  useEffect(() => {
    if (!open) return;
    setCmds(buildCommands(company.id));
    requestAnimationFrame(() => inputRef.current?.focus());
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, company.id]);

  const sections = useMemo(() => rank(query, cmds, { emptyLimit: { Invoices: 5, Docs: 5 } }), [query, cmds]);
  const flat = useMemo(() => flatten(sections), [sections]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (hit: Hit | undefined) => {
    if (!hit) return;
    const c = hit.cmd;
    setOpen(false);
    if (c.action === 'tour') { startTour(); return; }
    if (c.action?.startsWith('switch:')) { setCompany(c.action.slice(7)); return; }
    if (c.href) window.location.assign(c.href);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => moveIndex(i, 1, flat.length)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => moveIndex(i, -1, flat.length)); return; }
    if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(flat.length - 1); return; }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); run(flat[active]); return; }
    if (e.key === 'Tab') {
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  if (!open) return null;
  let index = -1;
  const mod = mac ? '⌘' : 'Ctrl';

  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}>
      <div ref={dialogRef} className="cmdk" role="dialog" aria-modal="true" aria-label="Search and commands" data-testid="cmdk" onKeyDown={onKeyDown}>
        <div className="cmdk-head">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            data-testid="cmdk-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optId(active) : undefined}
            placeholder="Search pages, invoices, docs or actions"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="cmdk-esc">Esc</kbd>
        </div>
        <div ref={listRef} className="cmdk-list" id={listId} role="listbox" aria-label="Results">
          {flat.length === 0 && <div className="cmdk-empty">No results for “{query.trim()}”</div>}
          {sections.map((s) => (
            <div key={s.group} role="group" aria-labelledby={`${uid}-g-${s.group}`} className="cmdk-group">
              <div className="cmdk-group-label" id={`${uid}-g-${s.group}`} role="presentation">{s.group}</div>
              {s.hits.map((h) => {
                index++;
                const i = index;
                return (
                  <div
                    key={h.cmd.id}
                    id={optId(i)}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    data-testid="cmdk-item"
                    data-href={h.cmd.href}
                    className="cmdk-item"
                    onMouseMove={() => { if (i !== active) setActive(i); }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(h)}
                  >
                    <span className="cmdk-item-title"><Highlighted text={h.cmd.title} hit={h} /></span>
                    {h.cmd.subtitle && <span className="cmdk-item-sub">{h.cmd.subtitle}</span>}
                    {i === active && <span className="cmdk-item-enter" aria-hidden="true">↵</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <span className="cmdk-foot-end"><kbd>{mod}</kbd><kbd>K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
