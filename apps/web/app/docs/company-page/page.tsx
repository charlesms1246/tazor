import { DocPage, Simulated } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="company-page" related={['company-on-ens', 'team-and-roles', 'security-page']}>
      <p>
        <a href="/company/">Company</a> is the one place for your company and its team: the profile and its ENS data, everyone
        who acts for it, how to add someone, and the controls to add a backup signer or remove a person.
      </p>
      <h2>Profile</h2>
      <p>
        The ENS name, the company name, its role in the demo, its account on Whitechain and its ENS registry. Links go to the
        ENS Explorer (the name, its registry and its roles) and to the registry contract&apos;s events on Sepolia Etherscan.
      </p>
      <h2>People</h2>
      <p>Each person shows their roles (Approver, Admin, Agent), their WB Soul status and their status on Whitechain:</p>
      <ul>
        <li><b>In sync</b>: Whitechain&apos;s role cache matches the company&apos;s ENS name.</li>
        <li><b>Syncing… ~1 min</b>: ENS changed within the last few minutes and the proof hasn&apos;t reached Whitechain yet.</li>
        <li><b>Out of sync</b>: ENS and the role cache have disagreed for longer; someone needs to run the role sync. The row shows when the cache last synced.</li>
        <li><b>Revoked</b>: the person is on the company&apos;s revocation list and can&apos;t approve.</li>
      </ul>
      <p>Select a person to open their panel:</p>
      <ul>
        <li>Their roles decoded from the live ENS role bitmap, with the raw bitmap.</li>
        <li><b>ENS (source of truth)</b> next to the <b>Whitechain role cache</b>, with the cache&apos;s L1 block and age.</li>
        <li>WB Soul on two lines: WhiteBIT&apos;s real mainnet registry, read live, and the testnet mirror.</li>
        <li>Links to their address on the ENS Explorer and the registry&apos;s role-change events.</li>
        <li>Their activity, and the actions to remove them or, for your own account, add a backup signer.</li>
      </ul>
      <Simulated>The testnet mirror line is simulated. Demo people have no Soul on mainnet, which the mainnet line shows truthfully. See <a href="/docs/wb-soul/">WB Soul</a>.</Simulated>
      <h2>Add a person</h2>
      <p>Roles are granted on ENS by an admin, not in the app. The card lists the steps and links to <b>Roles in ENS</b> and to approver onboarding.</p>
      <h2>Manage access</h2>
      <p>Add a backup signer to your own approver account, or remove someone from the company, without opening a person&apos;s panel.</p>
      <h2>How roles flow</h2>
      <p>
        Roles start on ENS on Ethereum, are proven to Whitechain by a storage proof, and are enforced on every payment. The
        automatic sync took 84 s in our measurement.
      </p>
    </DocPage>
  );
}
