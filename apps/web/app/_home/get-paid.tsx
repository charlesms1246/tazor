import './get-paid.css';

const STEPS: { n: string; title: string; benefit: string; href: string; cta: string; external?: boolean; testId: string }[] = [
  { n: '1', title: 'Customer pays', benefit: 'One signature, no gas, no WBT', href: 'https://bluejay-shop.vercel.app', cta: 'Try the demo shop', external: true, testId: 'story-pay' },
  { n: '2', title: 'Merchant refunds part of it', benefit: 'Only to the payer, never more than was paid', href: '/checkout/', cta: 'Open Checkout', testId: 'story-refund' },
  { n: '3', title: 'Accountant gets the export', benefit: 'Every payment and refund, as a CSV', href: '/export/#checkout', cta: 'Open Reports', testId: 'story-export' },
];

const ALSO: { label: string; href: string }[] = [
  { label: 'subscriptions', href: '/checkout/#subscriptions' },
  { label: 'pay from an exchange', href: '/docs/checkout/#exchange' },
  { label: 'AI agents (x402)', href: '/docs/agents-x402/' },
  { label: 'B2B approvals with verified people', href: '/approvals/' },
  { label: 'Ethereum fallback', href: '/docs/censorship-resistance/' },
];

/** Home: the one story Tazor tells on Whitechain, each step linking to where it happens. */
export function StoryStrip() {
  return (
    <section className="getpaid" aria-label="Get paid on Whitechain" data-testid="story">
      <div className="getpaid-head story-head">Get paid on Whitechain, in three steps
        <a className="btn btn-sm btn-primary" href="/start/" data-testid="story-start">Start accepting USDT</a></div>
      <ol className="getpaid-list story-list">
        {STEPS.map((s) => (
          <li key={s.n}>
            <a className="getpaid-item" href={s.href} data-testid={s.testId} {...(s.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
              <span className="story-n" aria-hidden="true">{s.n}</span>
              <span className="getpaid-title">{s.title}</span>
              <span className="getpaid-benefit">{s.benefit}</span>
              <span className="story-cta">{s.cta}{s.external ? ' ↗' : ' →'}</span>
            </a>
          </li>
        ))}
      </ol>
      <p className="story-also" data-testid="story-also">
        Also built: {ALSO.map((a, i) => <span key={a.href}>{i > 0 && ', '}<a href={a.href}>{a.label}</a></span>)}.
      </p>
    </section>
  );
}
