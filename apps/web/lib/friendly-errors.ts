/** Plain-English explanations, with the fix, for the errors a payer can hit on /pay. The original text stays available. */
export type Friendly = { title: string; fix: string; href?: string };

type Ctx = { company?: string; supplier?: string };

const RULES: [RegExp, (c: Required<Ctx>) => Friendly][] = [
  [/No passkey on this device/i, () => ({ title: "This device doesn't have an approver passkey yet.", fix: 'Create one on Approver setup, then come back to this link.', href: '/onboard/' })],
  [/NotAllowedError|not allowed by the user agent|timed out or was not allowed|AbortError|operation was aborted|cancel/i, () => ({ title: 'The passkey prompt was cancelled or timed out.', fix: 'Tap "Approve with passkey" again and confirm with Face ID, fingerprint or your device PIN.' })],
  [/PaymentMissingRole/, (c) => ({ title: `Your passkey account isn't an approver for ${c.company} yet.`, fix: 'Ask your admin to run the join command shown on Approver setup, then try again.', href: '/onboard/' })],
  [/PaymentNotVerified/, (c) => ({ title: `Your approver account isn't linked to a WhiteBIT-verified person (WB Soul) for ${c.company}.`, fix: 'Ask your admin to verify you on Approver setup; on testnet the verification is simulated.', href: '/onboard/' })],
  [/PaymentRevoked/, (c) => ({ title: `This approver has been removed from ${c.company}.`, fix: 'Ask an admin to add you again on the Company page.', href: '/company/' })],
  [/PaymentStaleRoles/, () => ({ title: "Whitechain's copy of your company's approver list is out of date.", fix: 'Sync the roles on the Policies page (Approvers), wait about a minute, then pay again.', href: '/policies/' })],
  [/PaymentNotEnoughApprovers/, () => ({ title: 'This payment needs another approval.', fix: 'Send your approval (shown above) to a second approver, then paste theirs and pay.' })],
  [/PaymentInvalidSignature|PaymentSignatureUsed/, () => ({ title: "An approval didn't verify for this invoice.", fix: 'Approve again on this device; if you pasted an approval, ask for a fresh one.' })],
  [/PaymentNonceUsed/, () => ({ title: 'This invoice has already been paid.', fix: 'Nothing more to do: see the Activity for the payment.' })],
  [/PaymentExpired|PaymentDeadlinePassed/, (c) => ({ title: 'This approval has expired.', fix: `Ask ${c.supplier} for a new payment link.` })],
  [/PaymentPayeeNotAllowed/, (c) => ({ title: `${c.company} hasn't approved ${c.supplier} as a payee yet.`, fix: 'An admin adds the payee on the Policies page; new payees can be paid after the payee delay.', href: '/policies/' })],
  [/PaymentOverPerPaymentLimit/, (c) => ({ title: `This invoice is over ${c.company}'s per-payment limit.`, fix: 'An admin can raise the limit on the Policies page, or split the invoice.', href: '/policies/' })],
  [/PaymentOverMonthlyLimit|PaymentOverAgentCap/, (c) => ({ title: `${c.company} has reached its spending limit for this month.`, fix: 'An admin can raise the monthly limit on the Policies page.', href: '/policies/' })],
  [/ERC20InsufficientBalance|PaymentTransferFailed|exceeds balance|insufficient/i, (c) => ({ title: `${c.company}'s account doesn't hold enough USDT for this invoice.`, fix: 'Top up the company account with test USDT, then pay again.' })],
  [/Relayer unreachable|relayer returned 5\d\d|upstream error/i, () => ({ title: "Tazor's relayer didn't answer.", fix: 'Your approval is still valid: use "Send via Ethereum" below, or "Copy calldata" and send it from any wallet.' })],
  [/no PaymentModule configuration/i, (c) => ({ title: `This relayer can't submit payments for ${c.company} yet.`, fix: 'Use "Copy calldata" and send it from any wallet, or "Send via Ethereum" below.' })],
  [/Relayer URL is not configured/i, () => ({ title: 'No relayer is set on this device.', fix: 'Choose one in Settings, or use "Send via Ethereum" / "Copy calldata".', href: '/settings/' })],
  [/No approvals yet/i, () => ({ title: 'Nobody has approved this invoice yet.', fix: 'Tap "Approve with passkey" first.' })],
];

/** The friendly version of an error message, or null if it isn't one we recognise. */
export function friendlyError(message: string, ctx: Ctx = {}): Friendly | null {
  const c = { company: ctx.company || 'your company', supplier: ctx.supplier || 'the supplier' };
  for (const [re, f] of RULES) if (re.test(message)) return f(c);
  return null;
}
