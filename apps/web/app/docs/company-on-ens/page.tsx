import { DocPage, Steps } from '../_doc.tsx';

export default function PageC() {
  return (
    <DocPage slug="company-on-ens" related={['team-and-roles', 'removing-a-person', 'timings']}>
      <p>
        Each company has an ENS name under <code>taz0r.eth</code>, for example <code>acme.taz0r.eth</code>, with its own ENSv2
        registry on Ethereum. That registry records who holds which role. Whitechain reads it by cryptographic proof, so no
        Tazor server decides who may approve.
      </p>
      <h2>Roles</h2>
      <ul>
        <li><b>Approver</b> can approve payments for the company.</li>
        <li><b>Admin</b> manages the team: adds payees, grants temporary access, removes people.</li>
        <li><b>Agent</b> is software that can pay within a 30-day cap.</li>
      </ul>
      <h2>How a role change reaches Whitechain</h2>
      <Steps>
        <li>An admin changes the role on the company&apos;s ENS registry on Ethereum.</li>
        <li>Whitechain learns the new Ethereum block about a minute later through its <code>L1Block</code> contract.</li>
        <li>Someone submits a storage proof to the <code>RoleCache</code> on Whitechain, which checks it against Ethereum and caches the role.</li>
      </Steps>
      <p>
        In our measurement, an automatic sync took 84 s from the ENS change to the cached role. A sync proof costs about
        0.96M gas and only runs when roles change, never on the payment path.
      </p>
      <h2>Who runs the sync</h2>
      <ul>
        <li><b>On demand.</b> When you open <a href="/company/">Company</a> and someone is out of sync, the page asks the relayer to sync them, and shows the transaction when it lands. You can also choose <b>Sync now</b> in a person&apos;s panel.</li>
        <li><b>A daily sweep.</b> The relayer also checks its watched company registries once a day.</li>
        <li><b>Anyone.</b> The proof is checked on-chain, so any account can submit it. No Tazor server has to be running for roles to reach Whitechain.</li>
      </ul>
      <p>
        If the relayer reports that Whitechain hasn&apos;t seen the ENS change yet, the page waits about a minute and tries once
        more. If role sync isn&apos;t enabled for your company&apos;s registry, the page says so and the manual route still works.
      </p>
      <h2>Why the cache can lag</h2>
      <p>
        A role removed on ENS still applies on Whitechain until the next sync. To stop someone immediately, use
        <a href="/docs/removing-a-person/"> Removing a person</a>, which takes effect on Whitechain directly.
      </p>
    </DocPage>
  );
}
