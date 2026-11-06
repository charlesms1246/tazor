import { DocPage } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="security-page" related={['censorship-resistance', 'freeze-device', 'removing-a-person']}>
      <p>
        <a href="/security/">Security</a> checks, from your device, everything a payment depends on, and keeps the controls
        for removals and lost devices in one place.
      </p>
      <h2>System health</h2>
      <ul>
        <li><b>Relayer</b>: whether this device&apos;s relayer answers. &quot;Not set&quot; is fine: you can still send payments yourself.</li>
        <li><b>Whitechain Sepolia</b>: the latest block and how many seconds ago it was made.</li>
        <li><b>Ethereum Sepolia</b>: the latest block.</li>
        <li><b>Ethereum fallback</b>: &quot;Ready&quot; when Ethereum is reachable and EnsGate is deployed, so a payment can go through Ethereum.</li>
        <li><b>Revocation mirror</b>: whether the relayer copies Whitechain removals to the company&apos;s ENS name. &quot;Not authorized&quot; means it isn&apos;t allowed to; a removal still takes effect on Whitechain at once.</li>
      </ul>
      <p>Choose <b>Refresh</b> to check again.</p>
      <h2>If our servers go down</h2>
      <p>Payments keep working without Tazor. See <a href="/docs/censorship-resistance/">Censorship resistance</a>.</p>
      <h2>Relayer and contracts</h2>
      <p>Choose the relayer this device uses, test it, or go back to the default. Below it are the contract addresses this build talks to.</p>
      <h2>Recent revocations</h2>
      <p>People revoked for the selected company, and removals made from this device, with their transactions. Each shows &quot;Mirrored to ENS&quot; once the person no longer holds the approver role on the company&apos;s ENS name.</p>
      <h2>Lost device</h2>
      <p>Last on the page, because it can&apos;t be undone. See <a href="/docs/freeze-device/">Freeze a device</a>.</p>
    </DocPage>
  );
}
