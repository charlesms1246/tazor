import { DocPage } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="security-model" related={['censorship-resistance', 'policies', 'testnet-simulations']}>
      <p>
        Tazor is built so that a payment can&apos;t be redirected: not by a stolen phone, a former employee, a hacked server
        or a tampered website. This page lists what enforces that, and what you still trust.
      </p>
      <h2>What you sign is what you see</h2>
      <p>
        Your device rebuilds the payment from the invoice link and compares its digest with the payment contract&apos;s
        before asking for Face ID. If they differ, it refuses to sign.
      </p>
      <h2>Checks on every payment</h2>
      <ul>
        <li>Each approver&apos;s signature is checked by their approver account on-chain.</li>
        <li>Each approver must be a WhiteBIT-verified person (WB Soul), and two approvers must be different people.</li>
        <li>No approver may be on the company&apos;s revocation list.</li>
        <li>Each approver must hold the approver role on the company&apos;s ENS name, from the role cache.</li>
        <li>On v2 accounts: limits, the new-payee delay and the fresh-proof rule from <a href="/docs/policies/">Policies</a>.</li>
      </ul>
      <h2>No back door over funds</h2>
      <p>
        The company account only lets Tazor&apos;s installed payment modules move funds, and only after these checks. There is
        no owner key and no upgrade key over company funds.
      </p>
      <h2>Keys</h2>
      <p>
        Approver keys are passkeys in the platform keychain, synced across the user&apos;s own devices and never sent to Tazor.
        Signatures are verified with Whitechain&apos;s P-256 precompile.
      </p>
      <h2>What you still trust</h2>
      <ul>
        <li><b>WhiteBIT</b> decides who is a verified person. It can revoke a person&apos;s verification; it cannot move company funds.</li>
        <li><b>Whitechain&apos;s proposer is permissioned.</b> We only claim that payments get in, not that withdrawals to Ethereum get out.</li>
        <li><b>Tether</b> can freeze USDT held by any address.</li>
        <li><b>Whoever controls the taz0r.eth contenthash</b> could serve a different app. The digest check above limits the damage, and the app build is reproducible, so anyone can compare it with the published version.</li>
      </ul>
    </DocPage>
  );
}
