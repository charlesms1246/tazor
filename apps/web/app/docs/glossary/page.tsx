import { DocPage } from '../_doc.tsx';

const TERMS: [string, string][] = [
  ['Approver account', 'A small smart account on Whitechain for one person. It verifies their passkey and, optionally, a backup signer.'],
  ['Backup signer', 'An ordinary wallet address added to an approver account as a second signer. Either one alone can approve.'],
  ['Company account', 'The company’s smart account on Whitechain that holds its USDT. Only Tazor’s installed payment modules can move funds, after their checks.'],
  ['EnsGate', 'A contract on Ethereum that checks ENS roles natively and forwards a signed payment to Whitechain through the OptimismPortal.'],
  ['ENS name', 'The company’s name under taz0r.eth, such as acme.taz0r.eth. Its ENSv2 registry records who holds which role.'],
  ['InvoiceAuth', 'The structured message an approver signs for one invoice: invoice hash, buyer account, payee, amount, expiry and nonce.'],
  ['Invoice hash', 'A fingerprint of the invoice’s exact contents. Approvals are bound to it.'],
  ['Mandate', 'A direct debit: a supplier may collect up to a fixed amount per period from a company account until it expires or is cancelled.'],
  ['OptimismPortal', 'Whitechain’s contract on Ethereum that accepts deposits for Whitechain, including payments forwarded by EnsGate.'],
  ['Passkey', 'A key kept in your device’s keychain and unlocked with biometrics. Synced across your own devices; never sent to Tazor.'],
  ['Paymaster', 'A contract that pays gas for approved operations. Tazor’s sponsors approver accounts bound to a verified WB Soul, within a daily quota.'],
  ['Payment run', 'Several invoices from one buyer paid with one approval.'],
  ['Relayer', 'Tazor’s optional service that submits signed transactions and pays their gas. Anyone can do the same.'],
  ['Revocation list', 'A Whitechain contract that records removed approvers per company. Removal takes effect immediately.'],
  ['Role cache', 'A Whitechain contract that stores ENS roles after verifying a storage proof from Ethereum.'],
  ['USDT', 'Tether’s dollar stablecoin. On the testnet it is a test token with no real value.'],
  ['WB Soul', 'WhiteBIT’s registry of verified people on Whitechain. Simulated by a mirror contract on the testnet.'],
  ['WBT', 'Whitechain’s gas token.'],
];

export default function Page() {
  return (
    <DocPage slug="glossary" related={['what-is-tazor', 'security-model', 'faq']}>
      <p>Short definitions of the terms used in the app and these docs, in alphabetical order.</p>
      <h2>Terms</h2>
      <dl className="kv">
        {TERMS.map(([t, d]) => [<dt key={`${t}-t`}>{t}</dt>, <dd key={`${t}-d`}>{d}</dd>])}
      </dl>
    </DocPage>
  );
}
