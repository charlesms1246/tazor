'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import './docs.css';
import { DOC_GROUPS, docHref } from './content.ts';

type TocItem = { id: string; text: string };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function DocsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/docs/';
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  const [toc, setToc] = useState<TocItem[]>([]);

  useEffect(() => {
    const hs = Array.from(document.querySelectorAll<HTMLHeadingElement>('.docs-article h2'))
      .filter((h) => !h.closest('.docs-related'));
    setToc(hs.map((h) => {
      if (!h.id) h.id = slugify(h.textContent ?? '');
      return { id: h.id, text: h.textContent ?? '' };
    }));
  }, [path]);

  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Docs topics" data-testid="docs-nav">
        <a href="/docs/" className="docs-nav-home" aria-current={path === '/docs/' ? 'page' : undefined}>Docs overview</a>
        {DOC_GROUPS.map((g) => (
          <div key={g.title} className="docs-nav-group">
            <div className="docs-nav-title">{g.title}</div>
            {g.pages.map((p) => (
              <a key={p.slug} href={docHref(p.slug)} aria-current={path === docHref(p.slug) ? 'page' : undefined}>{p.title}</a>
            ))}
          </div>
        ))}
      </nav>

      <div className="docs-article">
        <label className="docs-topic">
          <span className="field-label" style={{ display: 'block', marginBottom: 8 }}>Topic</span>
          <select className="select" data-testid="docs-topic" value={path} onChange={(e) => location.assign(e.target.value)}>
            <option value="/docs/">Docs overview</option>
            {DOC_GROUPS.map((g) => (
              <optgroup key={g.title} label={g.title}>
                {g.pages.map((p) => <option key={p.slug} value={docHref(p.slug)}>{p.title}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {children}
      </div>

      <aside className="docs-toc" aria-label="On this page">
        {toc.length > 0 && (
          <>
            <div className="docs-toc-title">On this page</div>
            {toc.map((t) => <a key={t.id} href={`#${t.id}`}>{t.text}</a>)}
          </>
        )}
      </aside>
    </div>
  );
}
