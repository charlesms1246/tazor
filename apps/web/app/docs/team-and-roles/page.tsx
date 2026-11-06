import { DocPage, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="team-and-roles" related={['company-on-ens', 'removing-a-person', 'approver-passkey']}>
      <p>
        Your team is the set of approver accounts that hold roles on your company&apos;s ENS name. Each person has their own
        approver account, secured by their passkey and, optionally, a backup signer.
      </p>
      <h2>Who does what</h2>
      <ul>
        <li><b>Approvers</b> approve invoices, payment runs, mandates and financing commitments.</li>
        <li><b>Admins</b> are the company account&apos;s own signers. They add payees, grant temporary access, set contractor expiry and remove people.</li>
        <li><b>Agents</b> are software that pays within a 30-day cap.</li>
      </ul>
      <p>Above your company&apos;s threshold, a payment needs two approvers who are different WhiteBIT-verified people.</p>
      <h2>Add a backup signer</h2>
      <p>A backup signer is an ordinary wallet address that can approve for you if you lose your passkey devices. Either one alone can approve.</p>
      <Steps>
        <li>Open <a href="/team/">Team</a> on the device that has your passkey.</li>
        <li>Enter the backup wallet&apos;s address.</li>
        <li>Choose <b>Add with Face ID</b>. The change is sponsored, so you need no WBT, within a daily quota per WB Soul.</li>
        <li>Wait for <b>Backup signer added</b>; the page checks it on-chain.</li>
      </Steps>
    </DocPage>
  );
}
