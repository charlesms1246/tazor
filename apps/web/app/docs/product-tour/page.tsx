import { DocPage } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="product-tour" related={['what-is-tazor', 'switching-companies', 'timings']}>
      <p>Tazor covers the whole cycle of business payments. This page goes through it in order, with where to find each step.</p>
      <h2>Receive</h2>
      <ul>
        <li><a href="/invoices/">Invoices</a>: create a payment link for a customer.</li>
        <li><a href="/mandates/">Collect</a>: collect under a mandate within the cap the customer signed.</li>
      </ul>
      <h2>Pay</h2>
      <ul>
        <li><a href="/pay/">Pay</a>: open a link, check it, approve with your passkey and pay.</li>
        <li><a href="/runs/">Payment runs</a>: pay many invoices from one buyer with one approval.</li>
      </ul>
      <h2>Control</h2>
      <ul>
        <li><a href="/company/">Company</a>: who acts for the company, their ENS data, and the controls to add a backup signer or remove someone.</li>
        <li><a href="/policies/">Policies</a>: limits, payee rules, temporary access and the time-locked exit.</li>
        <li><a href="/security/">Security</a>: system health, the Ethereum fallback and lost-device controls.</li>
      </ul>
      <h2>Books</h2>
      <ul>
        <li><a href="/export/">Reports</a>: Tally, Xero and QuickBooks CSVs, a camt.054-style file and the on-chain statement.</li>
      </ul>
    </DocPage>
  );
}
