import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
const { buildInvoice, formTotal, invoiceStatus, lineTotal, loadInvoices, newInvoiceId, parseUsdt, saveInvoice } = await import('../lib/invoices-store.ts');
const { decodeInvoiceLink, encodeInvoiceLink } = await import('../lib/invoice-link.ts');
const { WHITECHAIN_SEPOLIA_USDT } = await import('../lib/invoice-auth.ts');

beforeEach(() => store.clear());

const form = {
  customer: '0xea5a4be313e05eb254900b6adbb7d655c55242f6',
  payee: '0xc1dce946d192e344251972470237f1471c93876c',
  supplierName: 'Bluejay Logistics',
  supplierAccount: '',
  lines: [
    { description: 'Freight Mumbai to Pune', quantity: '2', unitPrice: '0.6' },
    { description: 'Handling', quantity: '1', unitPrice: '0.05' },
  ],
  dueDate: '2026-12-31',
  memo: 'PO 77',
};

test('parseUsdt: exact 6-decimal base units, rejects anything else', () => {
  assert.equal(parseUsdt('1.25'), 1_250_000n);
  assert.equal(parseUsdt('0.000001'), 1n);
  assert.equal(parseUsdt(' 3 '), 3_000_000n);
  for (const bad of ['', '1.2345678', '-1', '1e3', 'abc', '01', '1,5']) assert.equal(parseUsdt(bad), null, bad);
});

test('line and form totals (live total ignores incomplete lines)', () => {
  assert.equal(lineTotal(form.lines[0]), 1_200_000n);
  assert.equal(formTotal(form), 1_250_000n);
  assert.equal(formTotal({ ...form, lines: [...form.lines, { description: 'x', quantity: '', unitPrice: '9' }] }), 1_250_000n);
});

test('buildInvoice: a valid form gives an invoice the Pay page parser accepts', () => {
  const r = buildInvoice(form, 'INV-20261106-ABCD');
  assert.ok('invoice' in r, 'error' in r ? r.error : '');
  const i = r.invoice;
  assert.equal(i.amount, 1_250_000n);
  assert.equal(i.buyerAccount, '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6');
  assert.equal(i.supplierAccount, i.payee, 'supplier account defaults to the payee');
  assert.equal(i.token, WHITECHAIN_SEPOLIA_USDT);
  assert.equal(i.dueDate, Date.UTC(2026, 11, 31) / 1000);
  assert.equal(i.memo, 'PO 77');
});

test('buildInvoice: the link round-trips through the Pay page decoder', async () => {
  const r = buildInvoice(form, 'INV-20261106-ABCD');
  assert.ok('invoice' in r);
  const link = await encodeInvoiceLink(r.invoice, 'https://taz0r.eth.limo');
  assert.match(link, /^https:\/\/taz0r\.eth\.limo\/pay\/#v1\./);
  assert.deepEqual(await decodeInvoiceLink(link), r.invoice);
});

test('buildInvoice: each problem is reported', () => {
  const err = (patch: object) => { const r = buildInvoice({ ...form, ...patch }, 'X'); return 'error' in r ? r.error : ''; };
  assert.match(err({ customer: '0x1234' }), /Customer company account/);
  assert.match(err({ payee: '' }), /Payee/);
  assert.match(err({ supplierName: ' ' }), /supplier name/);
  assert.match(err({ supplierAccount: 'nope' }), /Supplier account/);
  assert.match(err({ lines: [] }), /at least one line/);
  assert.match(err({ lines: [{ description: '', quantity: '1', unitPrice: '1' }] }), /Line 1: enter a description/);
  assert.match(err({ lines: [{ description: 'a', quantity: '0', unitPrice: '1' }] }), /quantity/);
  assert.match(err({ lines: [{ description: 'a', quantity: '1', unitPrice: '0' }] }), /unit price/);
  assert.match(err({ dueDate: '' }), /due date/);
});

test('invoice ids are INV-YYYYMMDD-XXXX', () => {
  assert.equal(newInvoiceId(new Date('2026-11-06T10:00:00Z'), () => 0.5), 'INV-20261106-8000');
});

test('device list: newest first, de-duplicated by link, survives bad entries', () => {
  const a = buildInvoice(form, 'INV-A');
  const b = buildInvoice({ ...form, memo: 'second' }, 'INV-B');
  assert.ok('invoice' in a && 'invoice' in b);
  saveInvoice({ invoice: a.invoice, link: 'L1', createdAt: 1 });
  saveInvoice({ invoice: b.invoice, link: 'L2', createdAt: 2 });
  saveInvoice({ invoice: a.invoice, link: 'L1', createdAt: 3 });
  assert.deepEqual(loadInvoices().map((s) => [s.invoice.id, s.link]), [['INV-A', 'L1'], ['INV-B', 'L2']]);
  store.set('tazor.invoices.v1', JSON.stringify([{ invoice: '{"broken":true}', link: 'L3', createdAt: 4 }, ...JSON.parse(store.get('tazor.invoices.v1')!)]));
  assert.equal(loadInvoices().length, 2);
  store.set('tazor.invoices.v1', 'not json');
  assert.deepEqual(loadInvoices(), []);
});

test('status is paid only when a payment for the same invoice exists', () => {
  const a = buildInvoice(form, 'INV-A');
  const b = buildInvoice(form, 'INV-B');
  assert.ok('invoice' in a && 'invoice' in b);
  assert.equal(invoiceStatus(a.invoice, []), 'sent');
  assert.equal(invoiceStatus(a.invoice, [{ invoice: b.invoice, txHash: '0x01', blockTimestamp: 1 }]), 'sent');
  assert.equal(invoiceStatus(a.invoice, [{ invoice: a.invoice, txHash: '0x02', blockTimestamp: 1 }]), 'paid');
});
