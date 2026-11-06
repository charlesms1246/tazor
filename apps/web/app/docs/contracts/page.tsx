import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { DocPage } from '../_doc.tsx';

type Row = [string, string | null, 'wc' | 'sepolia'];

const ROWS: Row[] = [
  ['PaymentModule (v1)', config.paymentModule, 'wc'],
  ['PaymentModule v2', configV2.paymentModule, 'wc'],
  ['MandateModule (v1)', config.mandateModule, 'wc'],
  ['MandateModule v2', configV2.mandateModule, 'wc'],
  ['FinancingModule', configV2.financingModule, 'wc'],
  ['RevocationList (v1)', config.revocationList, 'wc'],
  ['RevocationList v2', configV2.revocationList, 'wc'],
  ['RoleCache', config.roleCache, 'wc'],
  ['ApproverAccountFactory', config.approverAccountFactory, 'wc'],
  ['TazorAccountFactory', config.tazorAccountFactory, 'wc'],
  ['EntryPoint v0.8', config.entryPoint, 'wc'],
  ['WB Soul mirror (simulated)', config.wbSoulMirror, 'wc'],
  ['USDT (testnet)', configV2.usdt, 'wc'],
  ['Demo company account', configV2.demoAccount, 'wc'],
  ['EnsGate (Ethereum Sepolia)', config.sepolia.ensGate, 'sepolia'],
  ['EnsGate v2 (Ethereum Sepolia)', configV2.ensGateV2, 'sepolia'],
];

export default function Page() {
  return (
    <DocPage slug="contracts" related={['relayer-api', 'testnet-simulations', 'censorship-resistance']}>
      <p>
        These are the addresses compiled into this build: Whitechain Sepolia (chain {config.chainId}) unless marked Ethereum
        Sepolia. Each links to its block explorer.
      </p>
      <h2>Addresses</h2>
      <div className="table-wrap"><table className="table" data-testid="docs-contracts">
        <thead><tr><th>Contract</th><th>Address</th></tr></thead>
        <tbody>
          {ROWS.map(([name, a, chain]) => (
            <tr key={name}>
              <td data-label="Contract">{name}</td>
              <td data-label="Address">{a
                ? <a className="mono break" href={`${chain === 'wc' ? config.explorer : config.sepolia.explorer}/address/${a}`} target="_blank" rel="noreferrer">{a}</a>
                : <span className="faint">not configured</span>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <h2>Networks</h2>
      <ul>
        <li>Whitechain Sepolia: chain {config.chainId}, RPC <code>{config.rpcUrl}</code>, explorer <a href={config.explorer} target="_blank" rel="noreferrer">{config.explorer}</a>.</li>
        <li>Ethereum Sepolia: chain {config.sepolia.chainId}, explorer <a href={config.sepolia.explorer} target="_blank" rel="noreferrer">{config.sepolia.explorer}</a>.</li>
      </ul>
    </DocPage>
  );
}
