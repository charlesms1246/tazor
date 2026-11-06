import { DocPage, Note, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="policies" related={['team-and-roles', 'security-model', 'mandates']}>
      <p>
        Policies are the rules the payment contract (PaymentModule v2) enforces on every payment from a company account.
        You can see them, and change some of them, on <a href="/policies/">Policies</a>.
      </p>
      <h2>Limits and rules</h2>
      <ul>
        <li><b>Two approvers above</b> an amount you set.</li>
        <li><b>Per-payment limit</b> and a <b>30-day limit</b>; the page shows how much of the 30-day limit is available now.</li>
        <li><b>New-payee delay</b>: every payee, including other Tazor companies, must be added by an admin and then wait this long before it can be paid.</li>
        <li><b>Fresh ENS proof above</b> an amount: larger payments need roles cached recently.</li>
        <li><b>Agent 30-day cap</b> for software agents.</li>
        <li><b>Exit accounts</b> and an exit delay, for the time-locked exit below.</li>
      </ul>
      <h2>Add a payee</h2>
      <Steps>
        <li>Load your company account on <a href="/policies/">Policies</a>.</li>
        <li>Enter the payee address and choose <b>Add payee (admin signs)</b>.</li>
        <li>Send the transaction through your wallet, or copy the calldata. The payee can be paid once the delay has passed.</li>
      </Steps>
      <h2>Temporary access</h2>
      <ul>
        <li><b>Provisional grant</b> gives approver or agent access for up to 10 minutes. It can never include admin and never counts as a fresh ENS proof.</li>
        <li><b>Contractor expiry</b> stops an approver approving after a date and time you choose.</li>
      </ul>
      <h2>Time-locked exit</h2>
      <p>
        An approver can request that the whole USDT balance move to one of the company&apos;s own exit accounts. After the exit
        delay anyone can execute it; until then any valid approver can cancel it.
      </p>
      <Note>v1 company accounts show approvers only; limits and payee rules are v2 features.</Note>
    </DocPage>
  );
}
