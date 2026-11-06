import './get-paid.css';

const ITEMS: { title: string; benefit: string; href: string; external?: boolean; testId: string }[] = [
  { title: 'Checkout', benefit: 'Customers pay with one signature: no WBT, no gas', href: 'https://bluejay-shop.vercel.app', external: true, testId: 'getpaid-checkout' },
  { title: 'Refunds & receipts', benefit: 'Refund in one click; every order has a public receipt', href: '/checkout/', testId: 'getpaid-refunds' },
  { title: 'Subscriptions', benefit: 'Charge every period without asking again', href: '/checkout/#subscriptions', testId: 'getpaid-subscriptions' },
  { title: 'AI agents (x402)', benefit: 'Let software pay for your API per request', href: '/checkout/#agents', testId: 'getpaid-agents' },
  { title: 'Invoice financing', benefit: 'Get paid now on invoices due later', href: '/financing/', testId: 'getpaid-financing' },
];

/** Home: what a business gets for selling on Whitechain, each linking to where it lives. */
export function GetPaid() {
  return (
    <section className="getpaid" aria-label="Get paid on Whitechain" data-testid="getpaid">
      <div className="getpaid-head">Get paid on Whitechain</div>
      <ul className="getpaid-list">
        {ITEMS.map((i) => (
          <li key={i.title}>
            <a className="getpaid-item" href={i.href} data-testid={i.testId} {...(i.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
              <span className="getpaid-title">{i.title}{i.external && <span className="getpaid-ext" aria-label="opens in a new tab"> ↗</span>}</span>
              <span className="getpaid-benefit">{i.benefit}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
