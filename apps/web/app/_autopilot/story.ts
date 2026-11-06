import { toEventSelector } from 'viem';
import type { Action, Ctx, SkipNote, Step } from './engine.ts';
import { TIMINGS } from '../../lib/timings.ts';

/** The pitch, end to end, on the real pages. Values the run learns (links, accounts, txs) live in ctx. */

const SHOP = 'https://bluejay-shop.vercel.app';
/** A relayer address that never answers: the page sees exactly what it sees when our servers are down. */
export const OFFLINE_RELAYER = 'https://relayer-offline.invalid';
const in90days = () => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

/** The Ethereum fallback recorded live with our servers off (lib/timings.ts), offered when a visitor has no Sepolia wallet. */
const fallbackTiming = TIMINGS.find((t) => /servers down/i.test(t.action));
export const RECORDED_FALLBACK: SkipNote = {
  text: `No Sepolia wallet? Skip; this was recorded live: ${fallbackTiming?.tazor ?? 'about a minute via Ethereum'} with our servers off.`,
  href: fallbackTiming?.proof?.find((p) => /whitechain/i.test(p.label))?.url ?? fallbackTiming?.proof?.[0]?.url,
};

/** MandateCreated(bytes32 indexed mandateId, address indexed account, address indexed payee, uint256, uint64, uint64), same in v1 and v2. */
export const MANDATE_CREATED = toEventSelector('MandateCreated(bytes32,address,address,uint256,uint64,uint64)');
/** MandateModule v1 and MandateModuleV2 on Whitechain Sepolia: the only emitters the run trusts for the mandate id. */
export const MANDATE_MODULES = ['0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32', '0x24b6eC6f6bf7e58bB3266b0b2701aE451ab7220F'];

/** The id of the mandate this run created: from its MandateCreated log, else the page's contract check. */
export const mandateForCollect = (c: Ctx) => c.mandateId || ((c.mandate ?? '').match(/0x[0-9a-fA-F]{64}/) ?? [''])[0];

/** Human names for the elements the Autopilot acts on, used in its messages. */
export const LABELS: Record<string, string> = {
  'inv-fill-sample': 'the "Fill with sample data" button', 'inv-create': 'the "Create payment link" button', 'inv-link': 'the payment link',
  'inv-customer': 'the customer field', 'inv-payee': 'the payee field', 'inv-supplier-account': 'the supplier account field', 'inv-supplier-name': 'the supplier name field',
  'inv-line-qty-0': 'the first line quantity', 'inv-line-price-0': 'the first line price', 'inv-line-qty-1': 'the second line quantity', 'inv-line-price-1': 'the second line price',
  'inv-total': 'the invoice total', 'inv-preview': 'the invoice preview',
  approve: 'the "Approve with passkey" button', pay: 'the "Pay" button', 'guard-ok': 'the contract check', amount: 'the amount',
  'pay-success-amount': 'the payment confirmation', 'pay-success-time': 'the settlement time', 'pay-success-tx': 'the transaction link',
  'run-links': 'the payment links box', 'run-prepare': 'the "Check run" button', 'run-approve': 'the "Approve run with passkey" button', 'run-pay': 'the "Pay run" button', 'run-tx': 'the run transaction',
  'm-account': 'the account field', 'm-payee': 'the payee field', 'm-cap': 'the limit field', 'm-expiry': 'the end date', 'm-prepare': 'the "Review" button',
  'm-digest': 'the contract check', 'm-approve': 'the "Approve with passkey" button', 'm-submit': 'the "Create mandate" button', 'm-tx': 'the mandate confirmation',
  'company-ens': 'the company ENS name', 'company-ens-links': 'the ENS links', 'registry-contract-link': 'the registry link', 'person-sync-state': 'the sync status',
  'relayer-url': 'the relayer address field', 'relayer-save': 'the "Save" button', 'relayer-clear': 'the "Clear" button', 'health-refresh': 'the "Refresh" button',
  'prepare-l1': 'the "Prepare Ethereum transaction" button', 'send-l1': 'the "Send with your wallet" button', 'l1-guide': 'the Blockscout guide', 'l1-blockscout-open': 'the "Open on Blockscout" link', activity: 'the activity list', tally: 'the "Tally CSV" button',
  create: 'the "Create passkey" button', 'approver-account': 'your approver account',
};

/** Total in USDT shown on the invoice form, or NaN. */
export const totalOf = (t: string | null) => Number((t ?? '').replace(/[^0-9.]/g, '')) || NaN;
/** Above this, the sandbox needs two approvers; every Autopilot payment (a run of two included) stays at or under it. */
export const MAX_PAYMENT = 0.5;

/** The sandbox supplier invoices the sandbox company; the link is kept as ctx[as]. Every account comes from the sandbox admit. */
const createInvoice = (as: string, say: string): Action[] => [
  { do: 'company', id: 'bluejay' },
  { do: 'goto', path: '/invoices/' },
  { do: 'click', testid: 'inv-fill-sample' },
  { do: 'fill', testid: 'inv-customer', value: (c) => c.buyerAccount },
  { do: 'fill', testid: 'inv-payee', value: (c) => c.supplierAccount },
  { do: 'fill', testid: 'inv-supplier-account', value: (c) => c.supplierAccount },
  { do: 'fill', testid: 'inv-supplier-name', value: (c) => c.supplierName || 'Sandbox Supplier' },
  // small lines: 0.12 + 0.05 = 0.17, plus 18 % GST ≈ 0.20 USDT, so a run of two is still ≤ 0.5
  { do: 'click', testid: 'inv-remove-line-2', optional: true, timeout: 600 },
  { do: 'fill', testid: 'inv-line-qty-0', value: '1' },
  { do: 'fill', testid: 'inv-line-price-0', value: '0.12' },
  { do: 'fill', testid: 'inv-line-qty-1', value: '1' },
  { do: 'fill', testid: 'inv-line-price-1', value: '0.05' },
  { do: 'waitFor', wait: { test: (d) => totalOf(d.text('inv-total')) <= MAX_PAYMENT / 2 }, timeout: 4000, say: 'Keeping the invoice small (about 0.20 USDT) so one approver is enough.' },
  { do: 'highlight', testid: 'inv-preview', say: 'The invoice paper updates as the form is filled.', ms: 1200 },
  { do: 'capture', testid: 'inv-total', as: `${as}Total` },
  { do: 'click', testid: 'inv-create' },
  { do: 'waitFor', wait: { test: (d, c) => { const t = d.attr('inv-link', 'data-link'); return !!t && t !== c.lastLink; } }, timeout: 20_000, say: 'Encrypting the invoice into a payment link…' },
  { do: 'capture', testid: 'inv-link', attr: 'data-link', as, say: () => say },
  { do: 'capture', testid: 'inv-link', attr: 'data-link', as: 'lastLink' },
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
      { do: 'capture', mode: 'guest', testid: 'approver-account', attr: 'data-value', as: 'approver' },
      {
        do: 'api', call: { name: 'sandbox-admit', args: (c) => ({ approver: c.approver }) }, say: 'Adding this passkey as an approver of the sandbox company…', sim: true,
        retry: { while: (r) => r.status === 'pending-sync', everyMs: 10_000, maxMs: 180_000, say: 'Waiting for Whitechain to see your new role (~1 min)…' },
      },
    ],
  },
  {
    id: 'ens', title: 'Company on ENS', why: 'Who may approve for the company is written on its ENS name, not in our database.',
    actions: [
      asBuyer,
      { do: 'goto', path: '/company/' },
      { do: 'highlight', testid: 'company-ens', say: 'The company is an ENS name; people are roles on its registry.' },
      { do: 'capture', testid: 'registry-contract-link', attr: 'href', as: 'registryUrl', say: () => 'The company’s ENS registry is public' },
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
      { do: 'capture', testid: 'pay-success-amount', as: 'paidWhat' },
      { do: 'capture', testid: 'pay-success-time', as: 'paidIn' },
      { do: 'capture', testid: 'pay-success-tx', attr: 'href', as: 'payment', tx: 'whitechain', say: (_v, c) => `${c.paidWhat}, ${c.paidIn.split('·')[0].trim().replace(/^Settled/, 'settled')}` },
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
      { do: 'capture', testid: 'run-tx', as: 'run', attr: 'href', inner: 'a', tx: 'whitechain', say: () => 'Paid two invoices to the supplier in one transaction' },
    ],
  },
  {
    id: 'mandate', title: 'Direct debit', why: 'The buyer signs a capped mandate once; the supplier collects within it, no approval each time.',
    actions: [
      asBuyer,
      { do: 'goto', path: '/mandates/' },
      { do: 'fill', testid: 'm-account', value: (c) => c.mandateAccount },
      { do: 'fill', testid: 'm-payee', value: (c) => c.supplierAccount },
      { do: 'fill', testid: 'm-cap', value: '0.30' },
      { do: 'fill', testid: 'm-expiry', value: in90days },
      { do: 'click', testid: 'm-prepare' },
      { do: 'capture', testid: 'm-digest', attr: 'data-value', as: 'mandate', say: () => '✓ The contract agrees with the mandate shown on this page.' },
      { do: 'userTap', testid: 'm-approve', prompt: 'Your turn: tap "Approve with passkey" to sign the mandate (up to 0.30 USDT a period).', until: { enabled: 'm-submit' } },
      { do: 'click', testid: 'm-submit' },
      { do: 'waitFor', wait: { testid: 'm-tx' }, timeout: 120_000, say: 'Creating the mandate on Whitechain…' },
      { do: 'capture', testid: 'm-tx', attr: 'href', inner: 'a', as: 'mandateCreated', tx: 'whitechain', say: (_v, c) => `✓ Mandate approved: ${c.supplierName || 'the supplier'} may collect up to 0.30 USDT a period` },
      { do: 'receiptLog', key: 'mandateCreatedTx', chain: 'whitechain', topic0: MANDATE_CREATED, topic: 1, addresses: MANDATE_MODULES, as: 'mandateId', say: 'Read the new mandate’s id from its transaction.', optional: true },
      { do: 'api', call: { name: 'counterparty', args: (c) => ({ action: 'collect', mandate: mandateForCollect(c) }) }, say: 'Simulated counterparty: Bluejay collects under the mandate…', sim: true },
    ],
  },
  {
    id: 'credit', title: 'Credit note', why: 'The supplier refunds part of an invoice; it lands as money in.',
    actions: [
      { do: 'api', call: { name: 'counterparty', args: () => ({ action: 'credit-note' }) }, say: 'Simulated counterparty: Bluejay sends a credit note…', sim: true },
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
      { do: 'log', text: 'Simulated outage: this device now uses a relayer address that never answers.', kind: 'warn' },
      { do: 'click', testid: 'health-refresh' },
      { do: 'waitFor', wait: { textIn: ['health-relayer', 'Unreachable'] }, timeout: 20_000, say: 'System health: the relayer is unreachable.' },
      ...createInvoice('offlineLink', 'Invoice for the outage test.'),
      ...approveLink('offlineLink'),
      { do: 'click', testid: 'pay' },
      { do: 'waitFor', wait: { testid: 'error' }, timeout: 30_000, say: 'Paying through our relayer fails, as expected…', optional: true },
      { do: 'click', testid: 'prepare-l1' },
      { do: 'highlight', testid: 'l1-guide', say: 'With our servers off, the same signed payment goes through Ethereum. Blockscout is the safest place to send it from.', ms: 2400 },
      { do: 'capture', testid: 'l1-blockscout-open', attr: 'href', as: 'blockscoutUrl' },
      {
        do: 'openTab', url: (c) => c.blockscoutUrl, timeout: 15 * 60_000,
        prompt: 'Your turn: on Blockscout, connect your wallet, open forward, paste the 5 fields from Tazor and press Write.',
        // the relayer is offline in this step, so a payment can only have arrived through Ethereum
        until: { testid: 'pay-success' },
        skipNote: RECORDED_FALLBACK,
      },
      { do: 'capture', testid: 'pay-success-tx', attr: 'href', as: 'fallback', tx: 'whitechain', say: () => 'Paid via Ethereum with our relayer offline; settled on Whitechain' },
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
