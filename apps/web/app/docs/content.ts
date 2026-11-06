export type DocPageMeta = { slug: string; title: string; summary: string };
export type DocGroup = { title: string; pages: DocPageMeta[] };

export const DOC_GROUPS: DocGroup[] = [
  {
    title: 'Get started',
    pages: [
      { slug: 'what-is-tazor', title: 'What is Tazor', summary: 'B2B invoices, payment runs and direct debits in USDT on Whitechain, approved by verified people.' },
      { slug: 'approver-passkey', title: 'Your approver passkey', summary: 'Create the passkey you approve with, and the approver account that goes with it.' },
      { slug: 'company-on-ens', title: 'Your company on ENS', summary: 'How a company name such as acme.taz0r.eth holds who may approve.' },
    ],
  },
  {
    title: 'Payments',
    pages: [
      { slug: 'create-invoice', title: 'Create an invoice', summary: 'Send an encrypted payment link that only the holder of the link can read.' },
      { slug: 'pay-invoice', title: 'Pay an invoice', summary: 'Open a payment link, check it, approve it with your passkey and pay.' },
      { slug: 'payment-runs', title: 'Payment runs', summary: 'Approve many invoices from one buyer with a single signature.' },
      { slug: 'mandates', title: 'Mandates (direct debits)', summary: 'Let a supplier collect up to a fixed amount each period, within limits you sign.' },
      { slug: 'financing', title: 'Invoice financing', summary: 'Turn an approved invoice into a claim that a financier can buy before the due date.' },
    ],
  },
  {
    title: 'Company',
    pages: [
      { slug: 'team-and-roles', title: 'Team and roles', summary: 'Approvers, admins and agents, and how a backup signer protects against a lost phone.' },
      { slug: 'policies', title: 'Policies', summary: 'Spending limits, payee rules, temporary access and the time-locked exit.' },
      { slug: 'removing-a-person', title: 'Removing a person', summary: 'Stop someone approving for your company in about three seconds.' },
      { slug: 'freeze-device', title: 'Freeze a device', summary: 'Revoke your own approver for a company if your phone is lost or compromised.' },
    ],
  },
  {
    title: 'Trust & safety',
    pages: [
      { slug: 'censorship-resistance', title: 'Censorship resistance', summary: 'How a signed payment still gets through if Tazor or the sequencer stops it.' },
      { slug: 'security-model', title: 'Security model', summary: 'What protects a payment from being redirected, and what you still have to trust.' },
      { slug: 'testnet-simulations', title: 'Testnet simulations', summary: 'What is simulated on Whitechain Sepolia, and what is real.' },
    ],
  },
  {
    title: 'Developers',
    pages: [
      { slug: 'relayer-api', title: 'Relayer API', summary: 'The optional, stateless relayer: every endpoint, request and response.' },
      { slug: 'contracts', title: 'Contracts', summary: 'Every contract address this build uses, with explorer links.' },
      { slug: 'passkey-check', title: 'Passkey check', summary: "Sign a test challenge with this device's passkey and verify it on Whitechain's P-256 precompile." },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'timings', title: 'Timings', summary: 'Typical bank times next to measured Tazor times, with the transactions that prove them.' },
      { slug: 'glossary', title: 'Glossary', summary: 'The terms used across Tazor, in one place.' },
      { slug: 'faq', title: 'FAQ', summary: 'Short answers to the questions finance teams ask first.' },
    ],
  },
];

export const ALL_DOC_PAGES: DocPageMeta[] = DOC_GROUPS.flatMap((g) => g.pages);

export function docPage(slug: string): DocPageMeta {
  const p = ALL_DOC_PAGES.find((x) => x.slug === slug);
  if (!p) throw new Error(`unknown doc page ${slug}`);
  return p;
}

export const docHref = (slug: string) => `/docs/${slug}/`;
