import { TIMINGS } from '@/lib/timings.ts';
import { DocPage } from '../_doc.tsx';

const HOW: Record<string, string> = {
  'Pay an approved invoice': 'One approved invoice paid through the relayer, end to end, on Whitechain Sepolia.',
  'Pay with our servers down (Ethereum fallback)': 'From the EnsGate transaction on Ethereum Sepolia to the payment landing on Whitechain, with the relayer bypassed.',
  'Set up a direct debit (mandate)': 'Creating a mandate is a single Whitechain transaction; the link is its first collection.',
  'Change who may approve': 'From the ENS role change on Ethereum to the role synced on Whitechain, block timestamp to block timestamp, including a 15 s scripted wait. The automatic watcher took 84 s.',
  'Remove a person': 'From submitting the signed revocation to its confirmed transaction on Whitechain; the person’s next payment was refused.',
  'Issue a credit note': 'A credit note is an ordinary payment from the supplier’s company account back to the buyer’s.',
};

export default function Page() {
  return (
    <DocPage slug="timings" related={['censorship-resistance', 'removing-a-person', 'company-on-ens']}>
      <p>
        Each Tazor figure below was measured on Whitechain Sepolia and Ethereum Sepolia, and links the transactions that
        prove it. Bank figures are typical published times for comparison.
      </p>
      <h2>Bank vs Tazor</h2>
      <div className="table-wrap"><table className="table table-stack" data-testid="docs-timings">
        <thead><tr><th>Action</th><th>Typical bank</th><th>Tazor</th><th>Proof</th></tr></thead>
        <tbody>
          {TIMINGS.map((t) => (
            <tr key={t.action}>
              <td>{t.action}</td>
              <td className="muted">{t.bank}</td>
              <td className="num">{t.tazor}{t.status !== 'measured' && <span className="cell-sub">{t.status}</span>}</td>
              <td>{t.proof?.map((p, i) => <span key={p.url}>{i > 0 && ' · '}<a href={p.url} target="_blank" rel="noreferrer">{p.label}</a></span>)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <h2>How each was measured</h2>
      <ul>
        {TIMINGS.map((t) => <li key={t.action}><b>{t.action}.</b> {HOW[t.action] ?? 'Measured on testnet; see the linked transaction.'}</li>)}
      </ul>
    </DocPage>
  );
}
