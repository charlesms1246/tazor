import { DOC_GROUPS, docHref } from './content.ts';

export default function DocsIndex() {
  return (
    <article data-testid="doc-index">
      <h1>Tazor docs</h1>
      <p className="docs-lead">
        How to send and pay invoices, run direct debits and manage who approves for your company, and how Tazor keeps
        payments flowing if we, or anyone else, stop serving them.
      </p>
      {DOC_GROUPS.map((g) => (
        <section key={g.title} className="docs-index-group" data-testid="docs-group">
          <h2>{g.title}</h2>
          <ul>
            {g.pages.map((p) => (
              <li key={p.slug}>
                <a href={docHref(p.slug)}>{p.title}</a>
                <span className="docs-summary">{p.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
