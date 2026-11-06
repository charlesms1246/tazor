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
      </ul>
      <p>Choose <b>Refresh</b> to check again.</p>
      <h2>If our servers go down</h2>
      <p>Payments keep working without Tazor. See <a href="/docs/censorship-resistance/">Censorship resistance</a>.</p>
      <h2>Recent revocations</h2>
      <p>People revoked for the selected company, and removals made from this device, with their transactions.</p>
      <h2>Lost device</h2>
      <p>The same freeze control as in Settings. See <a href="/docs/freeze-device/">Freeze a device</a>.</p>
    </DocPage>
  );
}
