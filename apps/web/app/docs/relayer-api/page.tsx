import { DocPage, Note } from '../_doc.tsx';

const auth = `{
  "invoiceHash": "0x…32 bytes",
  "account": "0x…buyer company account",
  "payee": "0x…",
  "amount": "1250500000",        // USDT base units (6 decimals), decimal or 0x string
  "expiry": "1801353600",        // unix seconds
  "nonce": "0x…"                 // uint256
}`;

const endpoints: [string, string, string, string][] = [
  ['GET', '/health', '–', '{ ok, relayer, paymentModule, approverAccountFactory, revocationList, mandateModule }'],
  ['POST', '/pay', '{ account, auth, approvers[], signatures[] }', '{ txHash, deployTxs? }'],
  ['POST', '/pay/calldata', 'same as /pay', '{ to, data }: submit it yourself'],
  ['POST', '/payrun', '{ account, auths[1..50], approvers[], signatures[] }', '{ txHash, paymentModule, deployTxs }'],
  ['POST', '/approver', '{ signer }: 84-byte passkey id or 20-byte address', '{ account, txHash | null }'],
  ['POST', '/revoke', '{ account, target, admin, deadline, sig, list? }', '{ txHash }'],
  ['POST', '/mandate', '{ mandate: { account, payee, capPerPeriod, period, expiry, nonce }, approvers[], signatures[] }', '{ txHash }'],
  ['POST', '/pull', '{ mandateId, amount }', '{ txHash }'],
  ['POST', '/rpc', 'JSON-RPC: pm_getPaymasterStubData, pm_getPaymasterData (ERC-7677)', 'paymaster fields and suggested gas'],
  ['POST', '/userop', '{ userOp }: EntryPoint v0.8 user operation', '{ txHash }'],
];

export default function Page() {
  return (
    <DocPage slug="relayer-api" related={['censorship-resistance', 'contracts', 'pay-invoice']}>
      <p>
        The relayer submits signed payments to Whitechain and pays the gas. It is optional: everything it does, anyone can
        do by sending the same calldata. It is stateless, keeps no database and does not log invoice contents.
      </p>
      <h2>Endpoints</h2>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Method</th><th>Path</th><th>Body</th><th>Response</th></tr></thead>
        <tbody>
          {endpoints.map(([m, p, b, r]) => (
            <tr key={p}><td>{m}</td><td><code>{p}</code></td><td className="small">{b}</td><td className="small">{r}</td></tr>
          ))}
        </tbody>
      </table></div>
      <h2>The InvoiceAuth object</h2>
      <p>Payments carry the EIP-712 <code>InvoiceAuth</code> each approver signed:</p>
      <pre><code>{auth}</code></pre>
      <p>
        <code>approvers</code> are approver account addresses and <code>signatures</code> their approvals, in the same order.
        An approval for an approver account that isn&apos;t deployed yet may be ERC-6492-wrapped; the relayer deploys it first and
        returns those transactions in <code>deployTxs</code>.
      </p>
      <h2>Behaviour</h2>
      <ul>
        <li>Every write is simulated first. A revert returns <b>422</b> with the reason, and nothing is sent.</li>
        <li>Malformed input returns <b>400</b>. A relayer without a key returns <b>503</b>, with <code>{'{ to, data }'}</code> where possible so you can send it yourself.</li>
        <li>Transactions are signed by the relayer&apos;s own key and sent one at a time.</li>
        <li><code>/revoke</code> uses the v1 revocation list unless <code>list</code> names the v2 one.</li>
        <li><code>/rpc</code> only sponsors approver accounts bound to a verified WB Soul, within a daily quota per soul; it refuses others before anyone signs.</li>
        <li>CORS is open, so the static app can call it from <code>taz0r.eth.limo</code>.</li>
      </ul>
      <Note>Choose which relayer this device uses in <a href="/settings/">Settings</a>.</Note>
    </DocPage>
  );
}
