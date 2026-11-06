import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="approver-passkey" related={['team-and-roles', 'freeze-device', 'passkey-check']}>
      <p>
        You approve payments with a passkey: a key your phone or laptop keeps in its keychain and unlocks with Face ID,
        a fingerprint or your device PIN (Windows Hello and Android work too). Tazor never sees it. Your approver account is a small smart account
        on Whitechain whose address is worked out from the passkey&apos;s public key.
      </p>
      <h2>Create your passkey</h2>
      <Steps>
        <li>Open <a href="/onboard/">Onboarding</a> on <code>taz0r.eth.limo</code>.</li>
        <li>Choose <b>Create passkey</b> and confirm with your device&apos;s biometrics.</li>
        <li>Tazor shows your approver account address and asks the relayer to deploy it. Deploying is free for you.</li>
        <li>Send the address to your company admin, so they can give it the approver role on your company&apos;s ENS name.</li>
      </Steps>
      <h2>Good to know</h2>
      <ul>
        <li><b>Passkeys belong to one website address.</b> A passkey made on <code>taz0r.eth.limo</code> only works there. Passkeys made on localhost or preview sites are throwaway.</li>
        <li><b>Passkeys are synced.</b> iCloud Keychain or Google Password Manager copies them to your other devices. They are not tied to one phone.</li>
        <li><b>Add a backup signer.</b> An ordinary wallet address can be added as a second signer, so you can still approve if you lose access to your passkey. See <a href="/docs/team-and-roles/">Team and roles</a>.</li>
      </ul>
      <Note>Your approval is checked on-chain: each approver account verifies the passkey signature using Whitechain&apos;s P-256 precompile.</Note>
    </DocPage>
  );
}
