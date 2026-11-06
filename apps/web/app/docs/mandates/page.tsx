import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="mandates" related={['policies', 'removing-a-person', 'timings']}>
      <p>
        A mandate is a direct debit. Your approvers sign once to let a supplier collect up to a fixed amount each period
        from the company account; the supplier then collects without asking again.
      </p>
      <h2>Set one up</h2>
      <Steps>
        <li>Open <a href="/mandates/">Mandates</a>.</li>
        <li>Enter the company account, the payee, the cap per period in USDT, the period (monthly, 30 days, or weekly) and the expiry date.</li>
        <li>Choose <b>Review</b>. Tazor checks the mandate against the contract before you sign.</li>
        <li>Approve with passkey, and add a second approver if the cap needs two.</li>
        <li>Choose <b>Create mandate</b>. It takes one transaction.</li>
      </Steps>
      <h2>Collecting</h2>
      <ul>
        <li>Each row shows what can be collected now in the current period.</li>
        <li>A collection above what is left is refused by the contract.</li>
        <li>The period resets automatically; unused amounts do not roll over.</li>
      </ul>
      <Note>A mandate keeps running after the approver who signed it is removed, until it is cancelled or expires.</Note>
    </DocPage>
  );
}
