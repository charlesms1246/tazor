import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="freeze-device" related={['removing-a-person', 'approver-passkey', 'security-model']}>
      <p>
        If your phone is lost or compromised, you can revoke your own approver for a company yourself, without waiting for
        an admin. It takes effect on Whitechain immediately.
      </p>
      <h2>Freeze</h2>
      <Steps>
        <li>Open <a href="/settings/">Settings</a> on a device that has your passkey.</li>
        <li>Under <b>Freeze this device</b>, enter the company account and choose <b>Freeze…</b>.</li>
        <li>Read the confirmation, then choose <b>Yes, freeze (Face ID)</b>.</li>
        <li>If the relayer is unavailable, send the calldata shown from any wallet.</li>
        <li>Choose <b>Check status</b> to confirm it is revoked.</li>
      </Steps>
      <h2>What it affects</h2>
      <ul>
        <li>It revokes your approver account for that company, so it applies on every device your passkey is synced to.</li>
        <li>It is permanent. An admin adds a new approver account for you afterwards.</li>
      </ul>
      <Note>Freezing does not touch the company&apos;s funds; it only stops this approver from approving.</Note>
    </DocPage>
  );
}
