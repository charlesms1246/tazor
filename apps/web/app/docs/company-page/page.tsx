import { DocPage, Simulated } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="company-page" related={['company-on-ens', 'team-and-roles', 'security-page']}>
      <p>
        <a href="/company/">Company</a> shows the selected company&apos;s profile and everyone who acts for it, read live from
        Whitechain and Ethereum.
      </p>
      <h2>Profile</h2>
      <p>The ENS name, the company name, its role in the demo, and its account on Whitechain, with links to the ENS app and the explorer.</p>
      <h2>People</h2>
      <p>Each person shows their roles (Approver, Admin, Agent), their WB Soul status and their status on Whitechain:</p>
      <ul>
        <li><b>In sync</b>: Whitechain&apos;s role cache matches the company&apos;s ENS name.</li>
        <li><b>Syncing… ~1 min</b>: ENS changed and the proof hasn&apos;t reached Whitechain yet.</li>
        <li><b>Revoked</b>: the person is on the company&apos;s revocation list and can&apos;t approve.</li>
      </ul>
      <Simulated>WB Soul status on testnet comes from the mirror contract, not WhiteBIT&apos;s live registry.</Simulated>
      <h2>How roles flow</h2>
      <p>
        Roles start on ENS on Ethereum, are proven to Whitechain by a storage proof, and are enforced on every payment. The
        automatic sync took 84 s in our measurement.
      </p>
    </DocPage>
  );
}
