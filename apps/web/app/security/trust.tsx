'use client';

import { Card } from '../_ui/index.tsx';

const PARTIES: { who: string; can: string; cannot: string }[] = [
  { who: 'WhiteBIT', can: 'Decides who is a verified person (WB Soul), and can remove that verification; that person then can’t approve.', cannot: 'Move company funds or approve a payment.' },
  { who: 'Tether', can: 'Freeze USDT held at any address, including a company account.', cannot: 'Approve or redirect a payment.' },
  { who: 'Whitechain’s proposer and Guardian', can: 'Delay or pause withdrawals from Whitechain back to Ethereum.', cannot: 'Stop a payment sent through Ethereum: it arrives as an Ethereum deposit, which Whitechain must include.' },
  { who: 'Whoever controls taz0r.eth’s content', can: 'Serve a different version of this app.', cannot: 'Make you sign something else: your device rebuilds each payment and checks it with the contract before you sign. The build is reproducible, so anyone can compare its content ID with the published one.' },
  { who: 'Tazor’s relayer', can: 'Refuse or delay sending a payment; it is optional.', cannot: 'Change what you signed. Anyone can send the same signed payment, and it also goes through Ethereum.' },
  { who: 'Sandbox demo keys', can: 'Play the other parties in the Autopilot (testnet only, held by the relayer, for the sandbox company only).', cannot: 'Act for any real company.' },
];

const STILL_WORKS = [
  'Your company’s USDT stays in its own account on Whitechain. There is no owner key and no upgrade key over it, and an admin can move it out through the time-locked exit.',
  'Who may approve stays on the company’s ENS name on Ethereum.',
  'A signed payment can still be delivered through Ethereum with the standalone page (fallback.html, one file you can keep) or the forward script, without Tazor’s site or servers.',
  'A backup key (an ordinary wallet you add on Approver setup) still approves from any other copy of Tazor. Passkeys are tied to this website’s address, so keep a backup key.',
  'Invoices live inside their payment links, not on a Tazor server.',
];

/** Who can do what, in plain words, and what keeps working without Tazor. */
export function TrustModel() {
  return (
    <Card title="Trust model" subtitle="What each party can and can’t do with your payments." testId="trust-model">
      <ul className="trust-list">
        {PARTIES.map((p) => (
          <li key={p.who} data-testid="trust-party">
            <b>{p.who}</b>
            <span><span className="trust-tag">Can</span> {p.can}</span>
            <span><span className="trust-tag trust-tag-not">Can’t</span> {p.cannot}</span>
          </li>
        ))}
      </ul>
      <h3 style={{ marginTop: 20 }}>What still works if Tazor disappears</h3>
      <ul className="trust-still" data-testid="trust-still-works">
        {STILL_WORKS.map((s) => <li key={s}>{s}</li>)}
      </ul>
      <p className="small muted" style={{ marginTop: 12 }}>
        <a href="/fallback.html" data-testid="trust-fallback-link">Open the standalone payment page</a> · <a href="/docs/security-model/">Security model</a> · <a href="/docs/censorship-resistance/">Censorship resistance</a>
      </p>
    </Card>
  );
}
