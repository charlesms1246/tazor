import { DocPage, Note } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="what-is-tazor" related={['approver-passkey', 'company-on-ens', 'censorship-resistance']}>
      <p data-testid="what-lead">
        Tazor is USDT checkout for businesses on Whitechain: customers pay without gas, merchants refund in one click, and accountants get the export.
      </p>
      <h2>How a sale works</h2>
      <ol>
        <li><b>The customer pays.</b> One signature in their wallet, or a transfer from an exchange such as WhiteBIT. They need USDT only: no WBT, no gas. Payment is confirmed on Whitechain in about 4 seconds.</li>
        <li><b>The merchant refunds, if needed.</b> One click on the Checkout page. A refund can only go back to the customer, and never for more than was paid.</li>
        <li><b>The accountant gets the export.</b> Reports lists every payment and refund with its transaction, as a CSV.</li>
      </ol>
      <p>Set up at <a href="/start/">Start accepting USDT</a>: a pay button for your website, or a payment link for chat, email or a QR on the counter. Details are in <a href="/docs/checkout/">Checkout, refunds &amp; subscriptions</a>.</p>
      <h2>Also built: B2B approvals</h2>
      <p>
        For business-to-business payments, Tazor also does invoicing and recurring billing in USDT. A supplier sends an invoice as
        a link; the buyer&apos;s approvers check it and approve it with a passkey (Face ID, a fingerprint or the device PIN); the
        USDT moves on Whitechain in a few seconds.
      </p>
      <h3>What makes it different</h3>
      <ul>
        <li><b>Approvers are verified people.</b> Each approver is checked against WhiteBIT&apos;s WB Soul identity registry in the same transaction as the payment.</li>
        <li><b>Your company decides who approves.</b> Roles live on your company&apos;s ENS name (for example <code>acme.taz0r.eth</code>) and are proven onto Whitechain, not taken from a Tazor server.</li>
        <li><b>Payments can&apos;t be redirected.</b> Your phone rebuilds what you sign from the invoice link and refuses if the contract disagrees. Removing a person takes effect in seconds.</li>
        <li><b>Payments can&apos;t be stopped.</b> Anyone can submit a signed payment. If Tazor&apos;s relayer is down, you can submit it yourself, or send it through Ethereum.</li>
      </ul>
      <h3>The end-to-end B2B cycle</h3>
      <ol>
        <li><b>Receive.</b> A supplier sends an invoice link, or collects under a mandate.</li>
        <li><b>Pay.</b> The buyer&apos;s approvers check the invoice and approve it with a passkey; USDT moves on Whitechain.</li>
        <li><b>Control.</b> Roles come from the company&apos;s ENS name, limits from its policies, and anyone can be removed in seconds.</li>
        <li><b>Books.</b> Every payment can be exported for your accounting system, alongside the on-chain statement.</li>
      </ol>
      <p>The <a href="/docs/product-tour/">Product tour</a> walks through each step in the app.</p>
      <h3>What you can do with B2B</h3>
      <ul>
        <li>Create invoices and share payment links.</li>
        <li>Pay one invoice, or a run of up to 50 invoices with one signature.</li>
        <li>Set up mandates so a supplier can collect a fixed amount each period.</li>
        <li>Export payments for Tally, Xero, QuickBooks or as an ISO 20022 camt.054-style file.</li>
      </ul>
      <h2>What it is not</h2>
      <p>
        Tazor is a self-custodial business account and billing layer. It holds no deposits and has no bank or card rails.
        There is no wallet, seed phrase or gas for approvers to manage.
      </p>
      <Note>This build runs on Whitechain Sepolia, a test network. Some parts are simulated; see <a href="/docs/testnet-simulations/">Testnet simulations</a>.</Note>
    </DocPage>
  );
}
