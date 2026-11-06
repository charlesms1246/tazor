import { DocPage } from '../_doc.tsx';

const QA: [string, React.ReactNode][] = [
  ['Do approvers need a crypto wallet or gas?', 'No. Approvers sign with a passkey. The relayer pays gas, and some account changes are sponsored by the paymaster.'],
  ['What happens if Tazor is down?', <>Payments still go through. Copy the calldata and send it from any wallet, or use <a href="/docs/censorship-resistance/">Send via Ethereum</a>.</>],
  ['Can Tazor move our money?', 'No. There is no owner key or upgrade key over company funds. Only the installed payment modules can move USDT, and only after the approvers’ checks.'],
  ['Where is my passkey stored?', 'In your device’s keychain (iCloud Keychain or Google Password Manager), synced to your own devices. Tazor never receives it.'],
  ['Can one person pay alone?', 'Below your company’s threshold, yes. Above it, two approvers who are different verified people must approve.'],
  ['How fast can we remove someone?', <>Seconds. Our measurement was 3.06 s. See <a href="/docs/removing-a-person/">Removing a person</a>.</>],
  ['Can an invoice be paid twice?', 'No. The invoice hash is used as the payment nonce, so a second payment of the same invoice is refused.'],
  ['Can we export to our accounting system?', <>Yes. <a href="/export/">Reports</a> exports Tally, Xero and QuickBooks CSVs and an ISO 20022 camt.054-style file.</>],
  ['Is this real money?', <>Not on this build. It runs on testnets with test USDT, and WB Soul is simulated. See <a href="/docs/testnet-simulations/">Testnet simulations</a>.</>],
];

export default function Page() {
  return (
    <DocPage slug="faq" related={['what-is-tazor', 'security-model', 'glossary']}>
      <p>Answers to the questions accounts teams usually ask first.</p>
      {QA.map(([q, a]) => (
        <section key={q}>
          <h2>{q}</h2>
          <p>{a}</p>
        </section>
      ))}
    </DocPage>
  );
}
