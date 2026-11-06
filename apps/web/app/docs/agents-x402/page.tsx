import { DocPage, Note, Simulated, Steps } from '../_doc.tsx';

const requirements = `{
  "scheme": "exact",
  "network": "whitechain-sepolia",
  "maxAmountRequired": "10000",            // 0.01 USDT (6 decimals)
  "asset": "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7",
  "payTo": "0x…your address",
  "resource": "https://api.example.com/report",
  "extra": { "name": "Tether USD", "version": "1" }
}`;

export default function Page() {
  return (
    <DocPage slug="agents-x402" related={['checkout', 'relayer-api', 'sdk']}>
      <p>
        x402 lets an AI agent pay for an API call in the same HTTP request. Tazor runs a facilitator for Whitechain: your API asks
        for a price, the agent signs one USDT transfer for that price, and the facilitator checks it and settles it on Whitechain.
        The agent needs USDT but no WBT for gas.
      </p>
      <h2>How a paid request works</h2>
      <Steps>
        <li>The agent calls your API without paying. Your API answers <b>402 Payment Required</b> with the payment requirements below.</li>
        <li>The agent signs a USDT <code>transferWithAuthorization</code> to your address for at most that amount, valid for up to an hour.</li>
        <li>It repeats the call with the signed payment in the <code>X-PAYMENT</code> header.</li>
        <li>Your API asks the facilitator to verify the payment, serves the response, then asks it to settle. The USDT arrives in about a second.</li>
      </Steps>
      <h2>Payment requirements</h2>
      <pre><code>{requirements}</code></pre>
      <p>The network id <code>eip155:1874</code> is accepted too.</p>
      <h2>Facilitator endpoints</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Method</th><th>Path</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td>GET</td><td><code>/x402/supported</code></td><td className="small">Lists the schemes and networks it settles.</td></tr>
          <tr><td>POST</td><td><code>/x402/verify</code></td><td className="small">Checks the signature, the amount, the balance and that the authorisation is unused.</td></tr>
          <tr><td>POST</td><td><code>/x402/settle</code></td><td className="small">Simulates, then submits the transfer and returns the transaction.</td></tr>
        </tbody>
      </table></div>
      <p>Bodies follow the x402 specification: <code>{'{ x402Version, paymentPayload, paymentRequirements }'}</code>.</p>
      <h2>Limits that protect the facilitator</h2>
      <ul>
        <li>An authorisation may be valid for at most one hour, and for no more than the price you asked.</li>
        <li>Every settlement is simulated before it is sent; per-agent and per-day limits apply.</li>
      </ul>
      <Note>Payments to you appear in <a href="/checkout/">Checkout</a>, Agents, with the agent&apos;s address, the resource and the transaction.</Note>
      <Simulated>This build runs on Whitechain Sepolia with test USDT.</Simulated>
    </DocPage>
  );
}
