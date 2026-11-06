import { DocPage, Simulated, Steps } from '../_doc.tsx';

export default function Page() {
  return (
    <DocPage slug="financing" related={['create-invoice', 'security-model', 'testnet-simulations']}>
      <p>
        Invoice financing lets a supplier get paid before the due date. The buyer&apos;s approvers commit to pay an invoice on
        its due date to whoever holds the claim then; the supplier can sell that claim at a discount.
      </p>
      <h2>How it works</h2>
      <Steps>
        <li><b>Commit.</b> On <a href="/financing/">Financing</a>, the buyer&apos;s approvers sign a commitment for the invoice: the amount, the due date and the holder. This creates a claim with an id.</li>
        <li><b>List.</b> The holder lists the claim at a price below its face value.</li>
        <li><b>Buy.</b> A financier buys the claim and becomes the holder. Claims can only be held by WhiteBIT-verified people.</li>
        <li><b>Settle.</b> On or after the due date, anyone can settle the claim; the buyer&apos;s account pays the holder the face value.</li>
      </Steps>
      <Simulated>Financier verification uses the WB Soul mirror on testnet, not WhiteBIT&apos;s live registry.</Simulated>
    </DocPage>
  );
}
