import { DocPage, Note, Simulated, Steps } from '../_doc.tsx';

const example = `<script src="./tazor-pay.js"></script>
<tazor-pay-button
  mode="wallet"
  merchant="0xc1dce946D192e344251972470237F1471C93876c"
  amount="0.20"
  order-ref="BJ-1042"
  label="Pay 0.20 USDT"></tazor-pay-button>
<script>
  document.querySelector('tazor-pay-button').addEventListener('tazor-paid', (e) => {
    document.querySelector('#order-status').textContent = 'Paid';
    const tx = document.querySelector('#order-tx');
    tx.href = e.detail.explorerUrl;
    tx.hidden = false;
  });
</script>`;

const server = `import { createInvoiceLink, watchPayment } from '@tazor/pay';

const link = await createInvoiceLink({
  supplierName: 'Bluejay Logistics',
  payee: '0xc1dce946D192e344251972470237F1471C93876c',
  buyerAccount: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
  lines: [{ description: 'Freight', quantity: 1, unitPrice: '100' }],
  taxRate: 18, taxLabel: 'GST',
  dueDate: '2026-12-31',
  id: 'BJ-1042',
});
// link.url → https://tazor-app.vercel.app/pay/#v1.…   link.amount → '118'

const stop = watchPayment({
  invoiceHash: link.invoiceHash,
  payee: '0xc1dce946D192e344251972470237F1471C93876c',
  onPaid: ({ txHash, amount, at }) => markOrderPaid('BJ-1042', txHash),
});`;

const attrs: [string, string][] = [
  ['mode', '"wallet" for wallet checkout (one EIP-3009 signature, no gas) with a "Pay from WhiteBIT or any exchange" option; leave it out for Tazor company invoices.'],
  ['merchant', 'Wallet mode, required. The address that receives the USDT (and signs refunds).'],
  ['amount', 'The USDT amount, e.g. "0.20" (up to 6 decimals). Required in wallet mode.'],
  ['order-ref', 'Wallet mode, required. Your order number; it becomes the on-chain order reference.'],
  ['deadline', 'Wallet mode. Minutes the customer has to pay (default 30).'],
  ['deposit', 'Wallet mode. "false" hides "Pay from WhiteBIT or any exchange".'],
  ['relayer', 'Wallet mode. The relayer that submits the signature (default Tazor\'s).'],
  ['supplier-name', 'Required. Your company name, shown on the invoice.'],
  ['payee', 'Required. The Whitechain address that receives the USDT.'],
  ['buyer', "Required. The customer's Tazor company account; its approvers approve and pay."],
  ['amount', 'A single amount in USDT, e.g. 12.50. Use this or lines.'],
  ['lines', 'JSON array of { description, quantity?, unitPrice } with unitPrice as a USDT string.'],
  ['memo', 'Shown to the customer, e.g. an order or PO number.'],
  ['due', 'Due day as YYYY-MM-DD. Defaults to 14 days from today.'],
  ['invoice-id', 'Your order number. Defaults to INV-YYYYMMDD-XXXX.'],
  ['tax-rate, tax-label', 'Optional tax, added as a final line the way the app adds it (label defaults to Tax).'],
  ['supplier-account', "Your Tazor account, if it isn't the payee."],
  ['app-url', 'The Tazor app that opens the link. Defaults to https://tazor-app.vercel.app.'],
  ['label', 'Button text. Defaults to "Pay with Tazor".'],
  ['target', 'popup opens a small window; anything else opens a new tab.'],
  ['explorer', 'Blockscout base URL. Defaults to the Whitechain testnet explorer.'],
];

const api: [string, string][] = [
  ['payOrder({ order, wallet })', 'Signs the order in any wallet (walletSigner(window.ethereum) or accountSigner(viemAccount)) and has the relayer submit it. Also refundOrder, subscribe, cancelSubscription, chargeSubscription, getOrder, watchOrder.'],
  ['depositOrder({ merchant, amount, ref, refundTo })', 'The per-order address to send USDT to by plain transfer, read from TazorDepositCheckout; watchDeposit(order, onUpdate) follows it.'],
  ['verifyWebhook(rawBody, header, secret)', 'Checks the Tazor-Signature header (t=…,v1=HMAC-SHA256) within ±300 s and returns the event.'],
  ['payFetch(url, { account, maxValue })', 'For agents: pays an HTTP 402 (x402 exact, USDT on Whitechain) once, refusing anything above maxValue.'],
  ['createInvoiceLink(input)', 'Promise of { id, url, invoiceHash, amount, amountBaseUnits, invoice }. Input: supplierName, payee, buyerAccount, lines, dueDate (YYYY-MM-DD, Date or unix seconds), and optional supplierAccount, taxRate, taxLabel, memo, id, appUrl.'],
  ['watchPayment({ invoiceHash, onPaid, payee?, intervalMs?, explorer?, onError? })', 'Polls Whitechain every 4 s by default and calls onPaid({ txHash, amount, at, payer, payee, viaL1, explorerUrl }) once. Returns stop().'],
  ['isPaid(invoiceHash, opts?)', 'Promise of true once the invoice is paid.'],
  ['getPayment(invoiceHash, opts?)', 'The payment, or null.'],
  ['decodeInvoiceLink(url)', 'The invoice inside a link, exactly as the app decrypts it.'],
  ['defineTazorPayButton(tag?)', 'Registers the custom element. tazor-pay.js already does this.'],
];

const events: [string, string][] = [
  ['tazor-finality', 'Wallet mode: each finality stage of the payment, { orderId, stage: "pending" | "sequencer" | "ethereum" | "finalized" }.'],
  ['tazor-link', 'The payment link is ready: { id, url, invoiceHash, amount, invoice }. element.link is the same value as a promise, if you need it before your listener exists.'],
  ['tazor-paid', 'Paid on Whitechain: { txHash, amount, at, payer, payee, explorerUrl, invoiceHash, url, id }.'],
  ['tazor-error', 'Bad attributes or a failed link: { message }.'],
];

export default function Page() {
  return (
    <DocPage slug="sdk" related={['create-invoice', 'pay-invoice', 'relayer-api']}>
      <p>
        <code>@tazor/pay</code> lets another website take a Tazor payment. It makes the same encrypted payment link the
        Invoices page makes, opens it in the Tazor app, and watches Whitechain until the invoice is paid. It has no server
        and no API key, and its only dependency is viem.
      </p>
      <h2>What the merchant and the customer see</h2>
      <Steps>
        <li>The customer clicks <b>Pay with Tazor</b> on the merchant&apos;s checkout. The button shows the amount.</li>
        <li>The Tazor app opens the invoice. The customer&apos;s approvers check it and approve it with a passkey; anyone, including the relayer, submits it.</li>
        <li>The button changes to <b>Waiting for payment…</b>, then <b>Paid ✓ · View tx</b> once the payment is on Whitechain, and fires <code>tazor-paid</code>.</li>
        <li>The merchant&apos;s own page or dashboard can watch the same invoice with <code>watchPayment</code>, on any device.</li>
      </Steps>
      <h2>Install</h2>
      <p>
        It isn&apos;t on npm yet. In the repository, build it from <code>packages/pay</code> with <code>pnpm build</code>, which
        writes <code>dist/index.js</code> (ES module) and <code>dist/tazor-pay.js</code> (one script for a{' '}
        <code>{'<script>'}</code> tag). The merchant demo in <code>examples/merchant-demo</code> already has a copy.
      </p>
      <h2>The whole integration: 15 lines</h2>
      <p>
        This is the integration from the Bluejay Logistics demo: one script, one element, one listener. There is no build
        step and no framework. In <code>mode=&quot;wallet&quot;</code> the customer pays from any wallet holding USDT with one
        signature (no gas, no WBT; Tazor&apos;s relayer submits it), or by a plain transfer from WhiteBIT or any exchange.
      </p>
      <pre><code>{example}</code></pre>
      <h2>From code</h2>
      <pre><code>{server}</code></pre>
      <h2>&lt;tazor-pay-button&gt; attributes</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Attribute</th><th>Meaning</th></tr></thead>
        <tbody>{attrs.map(([a, m]) => <tr key={a}><td data-label="Attribute"><code>{a}</code></td><td data-label="Meaning" className="small">{m}</td></tr>)}</tbody>
      </table></div>
      <p>
        Style it with CSS variables (<code>--tazor-bg</code>, <code>--tazor-fg</code>, <code>--tazor-accent</code>,{' '}
        <code>--tazor-radius</code>, <code>--tazor-font</code>, <code>--tazor-paid</code>) or with the parts{' '}
        <code>::part(button)</code>, <code>::part(label)</code>, <code>::part(status)</code> and <code>::part(tx)</code>.
      </p>
      <h2>Events</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Event</th><th>Detail</th></tr></thead>
        <tbody>{events.map(([e, d]) => <tr key={e}><td data-label="Event"><code>{e}</code></td><td data-label="Detail" className="small">{d}</td></tr>)}</tbody>
      </table></div>
      <p>The events bubble and cross the shadow root, so you can listen on the element or on <code>document</code>.</p>
      <h2>API</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Function</th><th>Returns</th></tr></thead>
        <tbody>{api.map(([f, r]) => <tr key={f}><td data-label="Function"><code>{f}</code></td><td data-label="Returns" className="small">{r}</td></tr>)}</tbody>
      </table></div>
      <h2>How payment is detected</h2>
      <p>
        PaymentModule emits <code>InvoicePaid(account, nonce, payee, amount, viaL1)</code>, and the nonce is the invoice hash
        (keccak256 of the canonical invoice). The SDK reads the newest logs of PaymentModule v1 and v2 from the Whitechain
        Blockscout API and matches that nonce, and the payee if you pass it. Payments sent through Ethereum count too.
      </p>
      <Note>
        The link carries the invoice encrypted with a key that only travels in the link&apos;s <code>#</code> part, so neither
        the merchant&apos;s server nor Tazor sees it. The <code>invoiceHash</code> reveals nothing about the invoice by itself.
      </Note>
      <Simulated>
        This build runs on Whitechain Sepolia with test USDT. The <code>buyer</code> must be a Tazor company account whose
        approvers have passkeys on the Tazor app.
      </Simulated>
    </DocPage>
  );
}
