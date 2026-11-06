import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="create-invoice" related={['pay-invoice', 'payment-runs', 'mandates']}>
      <p>
        An invoice in Tazor is a payment link. The invoice details are encrypted inside the link, and the key is in the part
        after <code>#</code>, which browsers never send to a server. Only someone who has the link can read it.
      </p>
      <h2>Create one</h2>
      <Steps>
        <li>Open <a href="/invoices/">Invoices</a>.</li>
        <li>Enter the customer&apos;s company account, the payee, your supplier name and account, the lines (quantity and unit price), the due date and an optional memo. The total is the sum of the lines, in USDT.</li>
        <li>Check the preview: it is exactly what your customer will see.</li>
        <li>Copy the payment link and send it to the buyer by email or chat.</li>
      </Steps>
      <h2>What the link guarantees</h2>
      <ul>
        <li><b>Tamper-evident.</b> The link is encrypted with AES-GCM. If anything in it changes, it no longer opens and the buyer sees &quot;Invalid or tampered link&quot;.</li>
        <li><b>A fixed fingerprint.</b> Each invoice has an invoice hash. The buyer&apos;s approvers sign that hash, so the payment is bound to this exact invoice.</li>
        <li><b>Paid once.</b> The invoice hash is also the payment&apos;s nonce, so the same invoice can&apos;t be paid twice.</li>
      </ul>
      <Note>An approval stays valid until 30 days after the invoice&apos;s due date.</Note>
    </DocPage>
  );
}
