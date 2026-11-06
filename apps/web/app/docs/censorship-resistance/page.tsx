import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="censorship-resistance" related={['pay-invoice', 'security-model', 'relayer-api']}>
      <p>
        A signed payment does not depend on Tazor to go through. Anyone can submit it, and if Whitechain&apos;s sequencer or
        our whole stack is unavailable, it can be sent through Ethereum instead.
      </p>
      <h2>Three ways to submit</h2>
      <ul>
        <li><b>The relayer.</b> Tazor&apos;s relayer submits the payment and pays the gas. It is optional and stateless.</li>
        <li><b>Your own wallet.</b> <b>Copy calldata</b> gives you the exact transaction; send it from any wallet or block explorer on Whitechain.</li>
        <li><b>Send via Ethereum.</b> The payment goes to Ethereum Sepolia and is delivered to Whitechain from there.</li>
      </ul>
      <h2>How Send via Ethereum works</h2>
      <Steps>
        <li>You send the payment to the <code>EnsGate</code> contract on Ethereum, from any wallet.</li>
        <li>EnsGate checks each approver&apos;s role on your company&apos;s ENS registry directly on Ethereum, in the same transaction.</li>
        <li>EnsGate deposits the payment into Whitechain through the <code>OptimismPortal</code>.</li>
        <li>On Whitechain, the payment contract accepts it only from EnsGate&apos;s address, then runs the usual checks (passkeys, WB Soul, revocation list) and pays the USDT.</li>
      </Steps>
      <p>
        Measured live: 69 s from the Ethereum transaction to the payment on Whitechain. If the sequencer refuses the
        deposit, OP Stack forced inclusion still delivers it within Whitechain&apos;s ~12 h sequencing window.
      </p>
      <h2>The app itself</h2>
      <p>
        The app is a static site on IPFS, reached at <code>taz0r.eth.limo</code> through ENS. If eth.limo is unavailable,
        approvers can still approve with their backup signer from any wallet.
      </p>
      <Note>Submitting through Ethereum needs only Ethereum. Confirming that it arrived needs any view of Whitechain.</Note>
    </DocPage>
  );
}
