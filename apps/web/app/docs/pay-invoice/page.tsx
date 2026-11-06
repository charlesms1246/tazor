import { DocPage, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="pay-invoice" related={['create-invoice', 'censorship-resistance', 'security-model']}>
      <p>
        Opening a payment link shows the invoice, checks it against the payment contract, and lets each approver approve it
        with their passkey. The payment then goes through the relayer, or you can send it yourself.
      </p>
      <h2>Pay</h2>
      <Steps>
        <li>Open the payment link. The invoice is decrypted on your device.</li>
        <li>Check the supplier. A &quot;Verified by WhiteBIT&quot; badge means at least one of the supplier company&apos;s admins is a WhiteBIT-verified person (simulated on testnet).</li>
        <li>Tazor rebuilds what you are about to sign from the link and compares it with the payment contract. If they differ, it refuses to sign and says so.</li>
        <li>Choose <b>Approve with passkey</b>.</li>
        <li>If the amount is above your company&apos;s threshold, a second approver approves too. Paste their approval into the page.</li>
        <li>Choose <b>Pay</b>. The page shows the transaction and how long it took.</li>
      </Steps>
      <h2>If the relayer is unavailable</h2>
      <ul>
        <li><b>Copy calldata</b> gives you the transaction to send from any wallet on Whitechain.</li>
        <li><b>Send via Ethereum</b> submits the payment on Ethereum Sepolia; it reaches Whitechain in about a minute. See <a href="/docs/censorship-resistance/">Censorship resistance</a>.</li>
      </ul>
      <h2>After paying</h2>
      <p>The payment is recorded on this device and appears in <a href="/export/">Reports</a>, ready to export.</p>
    </DocPage>
  );
}
