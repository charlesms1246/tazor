import { DocPage, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="payment-runs" related={['pay-invoice', 'policies', 'relayer-api']}>
      <p>
        A payment run pays several invoices from the same buyer account with one approval. Each invoice is checked exactly
        as on the Pay page; the approvers then sign one digest that covers them all.
      </p>
      <h2>Run a batch</h2>
      <Steps>
        <li>Open <a href="/runs/">Payment runs</a>.</li>
        <li>Paste one payment link per line. Every invoice must be paid by the same buyer account.</li>
        <li>Review the run: each invoice, its amount and the total.</li>
        <li>Approve with Face ID; a second approver joins if the total is above the threshold.</li>
        <li>Pay through the relayer, or copy the calldata.</li>
      </Steps>
      <h2>Rules</h2>
      <ul>
        <li>The relayer accepts up to 50 invoices in one run.</li>
        <li>The two-approver threshold is applied to the run&apos;s total, not to each invoice.</li>
        <li>Each invoice in the run is still marked paid on its own, so none of them can be paid again later.</li>
      </ul>
    </DocPage>
  );
}
