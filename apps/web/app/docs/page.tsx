import { DOC_GROUPS, docHref } from './content.ts';

export default function DocsIndex() {
  return (
    <article data-testid="doc-index">
      <h1>Tazor docs</h1>
      <p className="docs-lead" data-testid="docs-lead">
        Tazor is USDT checkout for businesses on Whitechain: customers pay without gas, merchants refund in one click, and accountants get the export.
      </p>
      <p>
        Set up your business at <a href="/start/">Start accepting USDT</a>, then read Checkout, refunds &amp; subscriptions under Payments below.
      </p>
      <h2 className="docs-also-h">Also built: B2B approvals</h2>
      <p>
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
