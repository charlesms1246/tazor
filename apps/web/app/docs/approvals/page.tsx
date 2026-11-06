import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="approvals" related={['pay-invoice', 'policies', 'security-model']}>
      <p>
        An approval is a passkey signature over one exact payment: the invoice hash, the buyer account, the payee, the
        amount, an expiry and a nonce. The payment contract checks each approval before any USDT moves.
      </p>
      <h2>Before you sign</h2>
      <p>
        Your device rebuilds the payment from the invoice link and compares its digest with the contract&apos;s. Face ID is
        only offered if they match, so you approve exactly what you see.
      </p>
      <h2>One approver or two</h2>
      <ul>
        <li>Below your company&apos;s threshold, one approver is enough.</li>
        <li>Above it, two approvers must approve, and they must be different WhiteBIT-verified people.</li>
        <li>For a payment run, the threshold applies to the run&apos;s total.</li>
      </ul>
      <h2>Add a second approver</h2>
      <Steps>
        <li>Approve on your device. The page shows your approval as a short block of text.</li>
        <li>Send it to the second approver, who opens the same payment link and approves.</li>
        <li>Paste their approval into the page, then choose <b>Pay</b>.</li>
      </Steps>
      <h2>Rules that still apply</h2>
      <ul>
        <li>An approval expires 30 days after the invoice&apos;s due date.</li>
        <li>An approver on the company&apos;s revocation list is refused, even with a valid signature.</li>
        <li>A backup signer&apos;s approval counts the same as a passkey approval.</li>
      </ul>
      <Note>Approvals are bound to the invoice hash, so changing any detail of the invoice makes them invalid.</Note>
    </DocPage>
  );
}
