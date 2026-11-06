import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="removing-a-person" related={['freeze-device', 'company-on-ens', 'timings']}>
      <p>
        Removing a person stops their approvals for your company on Whitechain straight away. In our measurement it took
        3.06 s from submitting to the confirmed transaction, and their next payment was refused.
      </p>
      <h2>Remove someone</h2>
      <Steps>
        <li>Open <a href="/company/">Company</a>. You need the admin role.</li>
        <li>Select the person in <b>People</b> to open their panel; the company and their approver account are filled in. You can also use <b>Manage access</b> on the page and enter both addresses yourself.</li>
        <li>Choose <b>Remove with passkey</b>. Tazor checks the request against the contract before you sign.</li>
        <li>The page shows the transaction and confirms <b>Revoked</b> on-chain.</li>
      </Steps>
      <h2>Things to know</h2>
      <ul>
        <li><b>It can&apos;t be undone.</b> To bring someone back, they create a new approver account.</li>
        <li><b>Mandates continue.</b> Mandates the person approved keep running until cancelled or expired.</li>
        <li><b>Update ENS too.</b> The removal is local to Whitechain. Remove their role on your ENS name as well (the person&apos;s panel links to <b>Roles in ENS</b>), so both views agree; the Company page shows any difference as Out of sync.</li>
      </ul>
      <Note>Anyone can remove their own approver for a company without the admin role. See <a href="/docs/freeze-device/">Freeze a device</a>.</Note>
    </DocPage>
  );
}
