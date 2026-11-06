import { config } from '@/lib/config.ts';
import { configV2 } from '@/lib/config-v2.ts';
import { DocPage, Simulated } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="testnet-simulations" related={['security-model', 'contracts', 'what-is-tazor']}>
      <p>
        This build runs on Whitechain Sepolia (chain 1874) and Ethereum Sepolia. Some pieces exist only on mainnet, so the
        testnet uses stand-ins. Everything else runs as it would in production.
      </p>
      <h2>Simulated</h2>
      <ul>
        <li>
          <b>WB Soul.</b> WhiteBIT&apos;s identity registry is not deployed on the testnet. A mirror contract with the same
          interface stands in for it: <a className="mono" href={`${config.explorer}/address/${config.wbSoulMirror}`} target="_blank" rel="noreferrer">{config.wbSoulMirror}</a>.
          Every &quot;Verified by WhiteBIT&quot; label on testnet comes from this mirror. On mainnet, souls live in the soul registry at <code>0x…2000</code>, and the IsVerified attribute in the attribute registry at <code>0x…2002</code>.
        </li>
        <li>
          <b>Money.</b> USDT on Whitechain Sepolia (<a className="mono" href={`${config.explorer}/address/${configV2.usdt}`} target="_blank" rel="noreferrer">{configV2.usdt}</a>) is a test token with no real value. WBT for gas comes from the testnet faucet.
        </li>
        <li><b>Demo companies.</b> Names such as <code>acme.taz0r.eth</code> and <code>bluejay.taz0r.eth</code> are demo accounts, not real businesses.</li>
      </ul>
      <Simulated>The live demo payments were approved with each approver&apos;s backup signer. Passkey signing is verified separately, against Whitechain&apos;s P-256 precompile.</Simulated>
      <h2>Real</h2>
      <ul>
        <li>The contracts, the payments and their transactions on Whitechain Sepolia.</li>
        <li>ENS names and roles on Ethereum Sepolia, and their proofs onto Whitechain.</li>
        <li>The Ethereum fallback through EnsGate and the OptimismPortal.</li>
      </ul>
    </DocPage>
  );
}
