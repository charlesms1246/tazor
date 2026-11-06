import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="switching-companies" related={['product-tour', 'create-invoice', 'pay-invoice']}>
      <p>
        The demo has two companies: Acme Industries (<code>acme.taz0r.eth</code>), the buyer, and Bluejay Logistics
        (<code>bluejay.taz0r.eth</code>), the supplier. Switching between them lets one person see both sides of a payment.
      </p>
      <h2>Switch</h2>
      <Steps>
        <li>Use the company switcher at the top of the sidebar.</li>
        <li>Choose Acme or Bluejay. Pages such as Company and Security follow your choice.</li>
      </Steps>
      <h2>Demo both sides</h2>
      <Steps>
        <li>As Bluejay, create an invoice for Acme on <a href="/invoices/">Invoices</a> and copy the link.</li>
        <li>Switch to Acme and open the link. Check the supplier badge and approve.</li>
        <li>Pay, then open <a href="/export/">Reports</a> to see the payment ready for the books.</li>
      </Steps>
      <Note>Your choice is stored on this device only. Both companies are demo accounts on the testnet.</Note>
    </DocPage>
  );
}
