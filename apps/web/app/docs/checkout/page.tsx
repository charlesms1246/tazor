import { DocPage, Note, Simulated, Steps } from '../_doc.tsx';

const events: [string, string][] = [
  ['order.paid', 'A customer paid an order.'],
  ['order.refunded', 'You refunded all or part of an order.'],
  ['order.finality', 'The payment moved to the next finality stage: sequencer, ethereum or finalized.'],
  ['subscription.created', 'A customer subscribed; the first cycle is paid.'],
  ['subscription.charged', 'A later cycle was charged.'],
  ['subscription.due', 'A cycle is due and will be charged.'],
  ['subscription.cancelled', 'The customer or you cancelled.'],
];

export default function Page() {
  return (
    <DocPage slug="checkout" related={['sdk', 'agents-x402', 'relayer-api']}>
      <p>
        Tazor Checkout takes USDT from any wallet on Whitechain, not only Tazor company accounts. The customer needs no WBT for
        gas: they sign one authorisation and Tazor&apos;s relayer submits it. Refunds and subscription charges are gasless for you too.
      </p>
      <h2>Paying an order</h2>
      <Steps>
        <li>Your site shows the order with its amount and your order number.</li>
        <li>The customer signs one USDT authorisation in their wallet (Face ID, fingerprint or the wallet&apos;s own unlock). It names your contract, the amount and the order, so it can&apos;t be used for anything else.</li>
        <li>The relayer submits it; the TazorCheckout contract takes the USDT and pays you in the same transaction, about a second later.</li>
        <li>The customer gets a public receipt link they can check themselves.</li>
      </Steps>
      <h2>Receipts and finality</h2>
      <p>
        A receipt (<a href="/receipt/">/receipt/?order=…</a>) is read straight from Whitechain, so it works even if Tazor is offline. It
        shows three stages: <b>confirmed by Whitechain</b> (about a second), <b>posted to Ethereum</b> (Whitechain&apos;s safe head
        has passed the block) and <b>final</b> (Ethereum finalized it). It updates by itself.
      </p>
      <h2>Refunds</h2>
      <p>
        In <a href="/checkout/">Checkout</a>, Orders, press Refund and choose the amount. Your wallet signs a USDT authorisation for that
        amount and the relayer submits it. The contract only sends a refund to the address that paid, and never more than was paid in
        total. Each refund appears on the customer&apos;s receipt with its transaction.
      </p>
      <h2>Subscriptions</h2>
      <p>
        The customer pays the first cycle now and allows later cycles with one permit, both signed in their wallet. Each later cycle
        can be charged by anyone once it is due (Tazor&apos;s relayer does it automatically). Either side can cancel at any time.
        Checkout, Subscriptions shows the next charge, and a Charge now button when a cycle is due.
      </p>
      <h2>Webhooks</h2>
      <p>Your server gets signed events. Each request carries <code>Tazor-Signature: t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of t.body&gt;</code>; reject any that don&apos;t verify or are more than five minutes old.</p>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Event</th><th>When</th></tr></thead>
        <tbody>{events.map(([e, w]) => <tr key={e}><td><code>{e}</code></td><td className="small">{w}</td></tr>)}</tbody>
      </table></div>
      <Note>Checkout, Webhooks lists recent deliveries and can send a test event to your endpoint.</Note>
      <Simulated>This build runs on Whitechain Sepolia with test USDT.</Simulated>
    </DocPage>
  );
}
