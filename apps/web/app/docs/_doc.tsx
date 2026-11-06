import type { ReactNode } from 'react';
import { docHref, docPage } from './content.ts';

/** One docs article: h1 and one-sentence lead from content.ts, the body, then a Related list. */
export function DocPage({ slug, related = [], children }: { slug: string; related?: string[]; children: ReactNode }) {
  const meta = docPage(slug);
  return (
    <article data-testid={`doc-${slug}`}>
      <h1>{meta.title}</h1>
      <p className="docs-lead">{meta.summary}</p>
      {children}
      {related.length > 0 && (
        <section className="docs-related">
          <h2>Related</h2>
          <ul>
            {related.map((r) => {
              const p = docPage(r);
              return <li key={r}><a href={docHref(r)}>{p.title}</a> <span className="muted">{p.summary}</span></li>;
            })}
          </ul>
        </section>
      )}
    </article>
  );
}

export const Steps = ({ children }: { children: ReactNode }) => <ol className="docs-steps">{children}</ol>;

export const Simulated = ({ children }: { children: ReactNode }) => <div className="notice notice-warning">{children}</div>;

export const Note = ({ children }: { children: ReactNode }) => <div className="notice notice-info">{children}</div>;
