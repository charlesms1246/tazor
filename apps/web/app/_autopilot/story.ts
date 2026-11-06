import type { Action, Ctx, Step } from './engine.ts';

/** The pitch, end to end, on the real pages. Values the run learns (links, accounts, txs) live in ctx. */

const SHOP = 'https://bluejay-shop.vercel.app';
/** A relayer address that never answers: the page sees exactly what it sees when our servers are down. */
export const OFFLINE_RELAYER = 'https://relayer-offline.invalid';
const in90days = () => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

/** The supplier invoices the sandbox company; the link is kept as ctx[as]. Every account comes from the sandbox admit. */
const createInvoice = (as: string, say: string): Action[] => [
  { do: 'company', id: 'bluejay' },
  { do: 'goto', path: '/invoices/' },
  { do: 'click', testid: 'inv-fill-sample' },
  { do: 'fill', testid: 'inv-customer', value: (c) => c.buyerAccount },
  { do: 'fill', testid: 'inv-payee', value: (c) => c.supplierAccount },
  { do: 'fill', testid: 'inv-supplier-account', value: (c) => c.supplierAccount },
  { do: 'highlight', testid: 'inv-preview', say: 'The invoice paper updates as the form is filled.', ms: 1200 },
  { do: 'capture', testid: 'inv-total', as: `${as}Total` },
  { do: 'click', testid: 'inv-create' },
  { do: 'waitFor', wait: { test: (d, c) => { const t = d.text('inv-link'); return !!t && t !== c.lastLink; } }, timeout: 20_000, say: 'Encrypting the invoice into a payment link…' },
  { do: 'capture', testid: 'inv-link', as, say: () => say },
  { do: 'capture', testid: 'inv-link', as: 'lastLink' },
];

const asBuyer: Action = { do: 'company', id: (c: Ctx) => c.buyerCompany };

/** Open a link as the buyer and approve it with the passkey (the browser only allows this on a real tap). */
const approveLink = (link: string): Action[] => [
  asBuyer,
  { do: 'goto', path: (c) => c[link] },
  { do: 'waitFor', wait: { testid: 'guard-ok' }, timeout: 30_000, say: 'Checking the invoice against the payment contract before signing…' },
  { do: 'highlight', testid: 'amount', say: 'The buyer sees exactly what the supplier invoiced.', ms: 1200 },
  { do: 'userTap', testid: 'approve', prompt: 'Your turn: tap "Approve with passkey" (Face ID, fingerprint or device PIN).', until: { testid: 'my-approval' } },
];

export const STORY: Step[] = [
  {
    id: 'ready', title: 'Get ready', why: 'Everything runs on the sandbox company, so simulated counterparties never touch a real company.',
    actions: [
      { do: 'api', mode: 'presenter', call: { name: 'preflight' }, say: 'Using the approver passkey already on this device…' },
      { do: 'goto', mode: 'guest', path: '/onboard/' },
      { do: 'userTap', mode: 'guest', testid: 'create', prompt: 'Your turn: tap "Create passkey". It stays in this device’s keychain.', until: { testid: 'approver-account' } },
      { do: 'capture', mode: 'guest', testid: 'approver-account', as: 'approver' },
      { do: 'api', call: { name: 'sandbox-admit', args: (c) => ({ approver: c.approver }) }, say: 'Adding this passkey as an approver of the sandbox company…', sim: true },
    ],
  },
  {
    id: 'ens', title: 'Company on ENS', why: 'Who may approve for the company is written on its ENS name, not in our database.',
    actions: [
      asBuyer,
      { do: 'goto', path: '/company/' },
      { do: 'highlight', testid: 'company-ens', say: 'The company is an ENS name; people are roles on its registry.' },
      { do: 'capture', testid: 'registry-contract-link', attr: 'href', as: 'registryUrl', say: (v) => `ENS registry contract: ${v}` },
      { do: 'highlight', testid: 'company-ens-links', ms: 1200 },
    ],
  },
  {
    id: 'invoice', title: 'Supplier creates an invoice', why: 'Bluejay invoices the buyer: the invoice travels encrypted inside a link.',
    actions: createInvoice('link', 'Payment link created; only someone holding it can read the invoice.'),
  },
  {
    id: 'open', title: 'Buyer opens the link', why: 'The buyer’s browser decrypts the invoice and checks it against the contract.',
    actions: approveLink('link').slice(0, 4),
  },
  {
    id: 'approve', title: 'Approve with passkey', why: 'A verified person signs exactly this invoice. No seed phrase, no wallet.',
    actions: [{ do: 'userTap', testid: 'approve', prompt: 'Your turn: tap "Approve with passkey" (Face ID, fingerprint or device PIN).', until: { testid: 'my-approval' } }],
  },
  {
    id: 'pay', title: 'Pay', why: 'The relayer submits it; USDT settles on Whitechain in seconds.',
    actions: [
      { do: 'click', testid: 'pay' },
      { do: 'waitFor', wait: { testid: 'pay-success' }, timeout: 120_000, say: 'Waiting for Whitechain…' },
      { do: 'capture', testid: 'pay-success-time', as: 'paidIn', say: (v) => v.split('·')[0].trim() },
      { do: 'capture', testid: 'pay-success-tx', attr: 'href', as: 'payment', tx: 'whitechain', say: () => 'Payment transaction' },
      { do: 'assertChain', key: 'paymentTx', chain: 'whitechain' },
    ],
  },
  {
    id: 'run', title: 'Payment run', why: 'Two invoices, one approval, one transaction.',
    actions: [
      ...createInvoice('run1', 'First invoice for the run.'),
      ...createInvoice('run2', 'Second invoice for the run.'),
      asBuyer,
      { do: 'goto', path: '/runs/' },
      { do: 'fill', testid: 'run-links', value: (c) => `${c.run1}\n${c.run2}` },
      { do: 'click', testid: 'run-prepare' },
      { do: 'waitFor', wait: { testid: 'run-table' }, timeout: 30_000, say: 'Checking both invoices…' },
      { do: 'userTap', testid: 'run-approve', prompt: 'Your turn: tap "Approve run with passkey". One signature covers both invoices.', until: { testid: 'run-my-approval' } },
      { do: 'click', testid: 'run-pay' },
      { do: 'waitFor', wait: { testid: 'run-tx' }, timeout: 120_000, say: 'Paying both invoices in one transaction…' },
      { do: 'capture', testid: 'run-tx', as: 'run', attr: 'href', inner: 'a', tx: 'whitechain', say: () => 'Two invoices paid in one transaction' },
    ],
  },
  {
    id: 'mandate', title: 'Direct debit', why: 'The buyer signs a capped mandate once; the supplier collects within it, no approval each time.',
    actions: [
      asBuyer,
      { do: 'goto', path: '/mandates/' },
      { do: 'fill', testid: 'm-account', value: (c) => c.mandateAccount },
      { do: 'fill', testid: 'm-payee', value: (c) => c.supplierAccount },
      { do: 'fill', testid: 'm-cap', value: '0.50' },
      { do: 'fill', testid: 'm-expiry', value: in90days },
      { do: 'click', testid: 'm-prepare' },
      { do: 'capture', testid: 'm-digest', as: 'mandate', say: () => 'The page rebuilt the mandate and the contract agrees on its digest.' },
      { do: 'userTap', testid: 'm-approve', prompt: 'Your turn: tap "Approve with passkey" to sign the mandate (up to 0.50 USDT a period).', until: { enabled: 'm-submit' } },
      { do: 'click', testid: 'm-submit' },
      { do: 'waitFor', wait: { testid: 'm-tx' }, timeout: 120_000, say: 'Creating the mandate on Whitechain…' },
      { do: 'capture', testid: 'm-tx', as: 'mandateCreated', tx: 'whitechain', say: () => 'Mandate created' },
      { do: 'api', call: { name: 'counterparty', args: (c) => ({ action: 'collect', mandate: (c.mandate.match(/0x[0-9a-fA-F]{64}/) ?? [''])[0], account: c.mandateAccount }) }, say: 'Simulated counterparty: Bluejay collects under the mandate…', sim: true },
    ],
  },
  {
    id: 'credit', title: 'Credit note', why: 'The supplier refunds part of an invoice; it lands as money in.',
    actions: [
      { do: 'api', call: { name: 'counterparty', args: (c) => ({ action: 'credit-note', account: c.buyerAccount }) }, say: 'Simulated counterparty: Bluejay sends a credit note…', sim: true },
      asBuyer,
      { do: 'goto', path: '/' },
      { do: 'highlight', testid: 'activity', say: 'Home shows the refund as money in.', ms: 2400 },
    ],
  },
  {
    id: 'revoke', title: 'Remove Ravi', why: 'Removing a person takes effect on Whitechain in seconds, and their next payment is refused.',
    actions: [
      { do: 'api', call: { name: 'counterparty', args: () => ({ action: 'revoke-ravi' }) }, say: 'Simulated counterparty: an admin removes Ravi…', sim: true },
      { do: 'api', call: { name: 'counterparty', args: () => ({ action: 'ravi-pays' }) }, say: 'Ravi tries to pay anyway…', sim: true, expectRefusal: true },
    ],
  },
  {
    id: 'sync', title: 'Role sync', why: 'Roles change on Ethereum (ENS) and are proven onto Whitechain; anyone can submit the proof.',
    actions: [
      asBuyer,
      { do: 'goto', path: '/company/' },
      { do: 'highlight', testid: 'person-sync-state', say: 'Each person: does Whitechain agree with ENS?', ms: 2000 },
      { do: 'api', call: { name: 'sync', args: (c) => ({ registry: c.registry, account: c.approver }) }, say: 'Asking the relayer to prove your role onto Whitechain…' },
    ],
  },
  {
    id: 'offline', title: 'Servers off', why: 'With our relayer unreachable, the same signed payment still goes through Ethereum.',
    actions: [
      { do: 'goto', path: '/security/' },
      { do: 'fill', testid: 'relayer-url', value: OFFLINE_RELAYER },
      { do: 'click', testid: 'relayer-save' },
      { do: 'log', text: `Simulated outage: this device now points at a relayer that doesn't answer (${OFFLINE_RELAYER}).`, kind: 'warn' },
      { do: 'click', testid: 'health-refresh' },
      { do: 'waitFor', wait: { textIn: ['health-relayer', 'Unreachable'] }, timeout: 20_000, say: 'System health: the relayer is unreachable.' },
      ...createInvoice('offlineLink', 'Invoice for the outage test.'),
      ...approveLink('offlineLink'),
      { do: 'click', testid: 'pay' },
      { do: 'waitFor', wait: { testid: 'error' }, timeout: 30_000, say: 'Paying through our relayer fails, as expected…', optional: true },
      { do: 'click', testid: 'prepare-l1' },
      { do: 'userTap', testid: 'send-l1', prompt: 'Your turn: tap "Send with your wallet" and confirm on Ethereum Sepolia.', until: { testid: 'pay-success' }, timeout: 15 * 60_000 },
      { do: 'capture', testid: 'pay-success-tx', attr: 'href', as: 'fallback', tx: 'whitechain', say: () => 'Delivered via Ethereum and settled on Whitechain' },
    ],
  },
  {
    id: 'restore', title: 'Restore the relayer', why: 'Back to normal: the default relayer for this build.',
    actions: [
      { do: 'goto', path: '/security/' },
      { do: 'click', testid: 'relayer-clear' },
      { do: 'click', testid: 'health-refresh' },
      { do: 'waitFor', wait: { textIn: ['health-relayer', 'Up'] }, timeout: 20_000, say: 'System health: the relayer is up again.' },
    ],
  },
  {
    id: 'financing', title: 'Financing', why: 'An approved invoice becomes a claim a financier can buy before the due date.',
    actions: [
      { do: 'api', call: { name: 'counterparty', args: () => ({ action: 'finance-buy' }) }, say: 'Simulated counterparty: a financier buys the claim…', sim: true },
      { do: 'api', call: { name: 'counterparty', args: () => ({ action: 'finance-settle' }) }, say: 'Simulated counterparty: the claim settles at the due date…', sim: true },
      { do: 'goto', path: '/financing/' },
    ],
  },
  {
    id: 'shop', title: 'Merchant checkout', why: 'The same payment, inside a shop’s checkout.',
    actions: [{ do: 'openTab', url: SHOP, prompt: 'Your turn: open the Bluejay shop in a new tab.' }],
  },
  {
    id: 'reports', title: 'Reports', why: 'Every payment with its transaction, ready for the accountant.',
    actions: [
      { do: 'goto', path: '/export/' },
      { do: 'highlight', testid: 'tally', say: 'Export for Tally, Xero, QuickBooks or as camt.053.' },
      { do: 'click', testid: 'tally' },
      { do: 'log', text: 'Tally export downloaded.', kind: 'ok' },
    ],
  },
];
