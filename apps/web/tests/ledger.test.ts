import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const { approvalRows, chainPaidMap, companyLedger, countBy, summarize } = await import('../lib/ledger.ts');
const { seedDirectory } = await import('./directory-fixture.ts');
seedDirectory();
const { companies } = await import('../lib/company.ts');
const COMPANIES = companies();
const { buildInvoice } = await import('../lib/invoices-store.ts');
const { invoiceHash } = await import('../lib/invoice.ts');

const acme = COMPANIES.find((c) => c.id === 'acme')!;
const bluejay = COMPANIES.find((c) => c.id === 'bluejay')!;
const NOW = 1_800_000_000;
const mk = (id: string, supplier: string, buyer: string, price: string, due: string) => {
  const r = buildInvoice({ customer: buyer, payee: supplier, supplierName: 'Bluejay Logistics', supplierAccount: supplier, lines: [{ description: 'x', quantity: '1', unitPrice: price }], dueDate: due, memo: '' }, id);
  assert.ok('invoice' in r, 'error' in r ? r.error : '');
  return { invoice: r.invoice, link: `http://x/pay/#v1.${id}`, createdAt: 1 };
};
const a = mk('INV-A', bluejay.account, acme.account, '1.00', '2030-01-01');       // Bluejay → Acme (v2)
const b = mk('INV-B', bluejay.account, acme.aliases[0], '2.50', '2020-01-01');    // Bluejay → Acme v1, overdue
const c = mk('INV-C', bluejay.account, acme.account, '0.30', '2030-01-01');       // paid on chain
const chain = [{ subject: invoiceHash(c.invoice).toLowerCase(), kind: 'paid', at: 1, title: 'INV-C paid: 0.30 USDT', tx: '0xabc', source: 'chain', block: 1, logIndex: 0, payer: acme.account, payee: bluejay.account, amount: '300000' }] as never[];

test('companyLedger: the same invoice is "sent" for the supplier and a "bill" for the buyer; status from device, chain, due date', () => {
  const inputs = { invoices: [a, b, c, a], payments: [], inbox: [], chainPaid: chainPaidMap(chain), now: NOW };
  const bj = companyLedger({ ...inputs, company: bluejay });
  const ac = companyLedger({ ...inputs, company: acme });
  assert.deepEqual(bj.sent.map((r) => [r.id, r.status]), [['INV-A', 'sent'], ['INV-B', 'overdue'], ['INV-C', 'paid']]);
  assert.equal(bj.bills.length, 0);
  assert.deepEqual(ac.bills.map((r) => r.id), ['INV-A', 'INV-B', 'INV-C'], 'the v1 alias counts as Acme');
  assert.equal(ac.sent.length, 0);
  assert.equal(ac.bills[2].paidTx, '0xabc');
  assert.deepEqual(summarize(bj.sent), { count: 3, open: 2, openTotal: 3_500_000n, overdue: 1, paid: 1 });
});

test('companyLedger: bills opened from a link on this device join the buyer list once', () => {
  const opened = { id: invoiceHash(a.invoice), kind: 'invoice', title: 'Invoice INV-A', counterparty: 'Bluejay Logistics', amount: '1000000', dueDate: 1893456000, href: 'http://x/pay/#v1.A', createdAt: 1, status: 'needs-approval', approvals: 0, account: acme.account } as const;
  const other = { ...opened, id: '0x' + 'ee'.repeat(32), title: 'Invoice INV-Z', amount: '700000' };
  const ac = companyLedger({ company: acme, invoices: [a], payments: [], inbox: [opened, other], chainPaid: new Map(), now: NOW });
  assert.deepEqual(ac.bills.map((r) => [r.id, r.amount]), [['INV-A', 1_000_000n], ['INV-Z', 700_000n]]);
  assert.equal(ac.bills[1].counterpartyName, 'Bluejay Logistics');
});

test('approvalRows: one row per invoice for the selected company; chain payments mark device items paid and add the rest', () => {
  const item = (id: string, account: string, status: 'needs-approval' | 'paid' = 'needs-approval') =>
    ({ id, kind: 'invoice', title: id, href: '/pay/', createdAt: 1, status, approvals: 0, account }) as const;
  const cHash = invoiceHash(c.invoice).toLowerCase();
  const items = [item('0x01', acme.account), item(cHash, acme.account), item('0x02', bluejay.account), item('0x03', acme.aliases[0], 'paid')];
  const dupChain = [...chain, ...chain, { ...(chain[0] as object), subject: '0x' + '44'.repeat(32), tx: '0xdef' }] as never[];
  const { rows, paidOnChain } = approvalRows(items, dupChain, acme);
  assert.equal(paidOnChain, 2, 'unique invoices, not events');
  assert.equal(rows.length, 4, "acme's three device items + one chain-only payment; bluejay's item left out");
  assert.equal(countBy(rows, 'paid'), 3);
  assert.equal(countBy(rows, 'needs-approval'), 1);
  assert.equal(rows.find((r) => r.id === cHash)!.chain!.tx, '0xabc');
});
