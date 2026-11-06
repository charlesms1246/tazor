import { DocPage, Simulated, Steps } from '../_doc.tsx';
import { SoulLookup } from '../../_soul/soul-lookup.tsx';

export default function Page() {
  return (
    <DocPage slug="wb-soul" related={['testnet-simulations', 'security-model', 'team-and-roles']}>
      <p>
        Tazor only accepts approvals from people WhiteBIT has verified. That verification is WB Soul: an identity record on
        Whitechain mainnet that WhiteBIT links to a person&apos;s wallet addresses after KYC.
      </p>
      <h2>Real Soul and the testnet mirror</h2>
      <p>
        WB Soul exists only on Whitechain mainnet, at <code>0x…2000</code>, with the IsVerified attribute held in the attribute
        registry at <code>0x…2002</code>. Tazor runs on Whitechain Sepolia, where there is no WB Soul, so payments there check a mirror
        contract with the same interface that we fill ourselves.
      </p>
      <Simulated>
        Every &quot;Verified (simulated)&quot; label refers to the testnet mirror. It shows the check works; it doesn&apos;t prove that anyone is
        a WhiteBIT-verified person.
      </Simulated>
      <p>
        Wherever a person appears, Tazor shows two lines: <b>WB Soul (mainnet)</b>, read live from the real registry, and
        <b> Testnet mirror</b>, which is what the testnet payment contracts used. Only the first line says anything about WhiteBIT.
      </p>
      <h2>How a company admin gets a real Soul</h2>
      <Steps>
        <li>Complete identity verification (KYC) with WhiteBIT.</li>
        <li>WhiteBIT assigns your wallet address to your Soul on Whitechain mainnet and sets IsVerified.</li>
        <li>Check your address below. Once it shows Verified, you pass the identity check that Tazor&apos;s payment contracts make for every approver.</li>
      </Steps>
      <p>
        As observed on chain, the address assignments (<code>assignAddress</code>, <code>registerSoul</code>) are sent by WhiteBIT&apos;s
        operator <code>0xb358…0ED9</code>, so you don&apos;t send a mainnet transaction yourself. WhiteBIT doesn&apos;t publish this as a
        guarantee; it is simply what the registry&apos;s history shows.
      </p>
      <h2>What WhiteBIT can and can&apos;t do</h2>
      <ul>
        <li>It can verify a person, and it can revoke that verification. A revoked person can no longer approve payments.</li>
        <li>It can&apos;t move company funds or approve a payment on anyone&apos;s behalf.</li>
      </ul>
      <h2>Check any address</h2>
      <SoulLookup />
    </DocPage>
  );
}
