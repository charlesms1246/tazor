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

test('tax line: rate parsing and half-up rounding in 6-dp base units', async () => {
  const { parseRate, taxFor } = await import('../lib/invoices-store.ts');
  assert.equal(parseRate('18'), 1800n);
  assert.equal(parseRate('12.5'), 1250n);
  assert.equal(parseRate('0'), 0n);
  for (const bad of ['', '-1', '101', '1.234', 'abc', '018']) assert.equal(parseRate(bad), null, bad);
  assert.equal(taxFor(100_000_000n, 1800n), 18_000_000n);
  assert.equal(taxFor(5n, 1000n), 1n); // 0.5 rounds up
  assert.equal(taxFor(4n, 1250n), 1n); // 0.5 rounds up
  assert.equal(taxFor(3n, 1000n), 0n); // 0.3 rounds down
  assert.equal(taxFor(14n, 1000n), 1n); // 1.4 rounds down
  assert.equal(taxFor(15n, 1000n), 2n); // 1.5 rounds up
});

test('withTax: final line keeps amount == sum of lines, parseInvoice accepts it, splitTax recovers it', async () => {
  const { withTax, draftTax, splitTax } = await import('../lib/invoices-store.ts');
  const f = { ...form, lines: [{ description: 'Freight', quantity: '1', unitPrice: '100' }] };
  assert.deepEqual(draftTax(f, '18', 'GST'), { label: 'GST', rate: '18', amount: 18_000_000n });
  const taxed = withTax(f, '18', 'GST');
  assert.deepEqual(taxed.lines.at(-1), { description: 'GST 18%', quantity: '1', unitPrice: '18' });
  const r = buildInvoice(taxed, 'INV-TAX-1');
  assert.ok('invoice' in r, 'error' in r ? r.error : '');
  assert.equal(r.invoice.amount, 118_000_000n);
  assert.equal(r.invoice.amount, r.invoice.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0n));
  const split = splitTax(r.invoice.lines);
  assert.equal(split.lines.length, 1);
  assert.deepEqual(split.tax, { label: 'GST', rate: '18', amount: 18_000_000n });

  const odd = withTax({ ...form, lines: [{ description: 'Tiny', quantity: '1', unitPrice: '0.000005' }] }, '10', ' ');
  assert.deepEqual(odd.lines.at(-1), { description: 'Tax 10%', quantity: '1', unitPrice: '0.000001' });
  const r2 = buildInvoice(odd, 'INV-TAX-2');
  assert.ok('invoice' in r2 && r2.invoice.amount === 6n);

  assert.equal(withTax(f, '', 'GST'), f);
  assert.equal(withTax(f, '0', 'GST'), f);
  assert.equal(withTax({ ...form, lines: [{ description: 'x', quantity: '1', unitPrice: '0.000001' }] }, '10', 'GST').lines.length, 1); // rounds to 0: no line
  // a final line that only looks like tax (wrong amount) is left as a line
  const r3 = buildInvoice({ ...f, lines: [...f.lines, { description: 'GST 18%', quantity: '1', unitPrice: '17' }] }, 'INV-TAX-3');
  assert.ok('invoice' in r3 && splitTax(r3.invoice.lines).tax === null);
});

test('supplier account follows the payee until edited; prefill sets both; warning when it is still the company account', async () => {
  const { applyFormEdit, prefillForm, supplierAccountWarning } = await import('../lib/invoices-store.ts');
  const acme = { name: 'Acme Industries', account: '0xb99A12652BEe98429ae31EA0529A0b63f1073721' };
  const bluejay = { name: 'Bluejay Logistics', account: '0xc1dce946D192e344251972470237F1471C93876c' };
  const blank = { customer: '', payee: '', supplierName: '', supplierAccount: '', lines: [], dueDate: '', memo: '' };

  const touched = new Set<keyof typeof blank>();
  let f = prefillForm(blank, acme, bluejay, touched);
  assert.equal(f.payee, acme.account);
  assert.equal(f.supplierAccount, acme.account);
  assert.equal(f.supplierName, acme.name);
  assert.equal(f.customer, bluejay.account);
  assert.equal(supplierAccountWarning(f, acme), null);

  // typing a payee moves an untouched supplier account with it
  f = applyFormEdit(f, { payee: bluejay.account }, touched); touched.add('payee');
  assert.equal(f.supplierAccount, bluejay.account);
  // a later company switch keeps the typed payee and the account that follows it
  assert.equal(prefillForm(f, bluejay, acme, touched).supplierAccount, bluejay.account);

  // once the supplier account itself is edited it stays put
  f = applyFormEdit(f, { supplierAccount: acme.account }, touched); touched.add('supplierAccount');
  f = applyFormEdit(f, { payee: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6' }, touched);
  assert.equal(f.supplierAccount, acme.account);
  assert.equal(prefillForm(f, bluejay, acme, touched).supplierAccount, acme.account);

  // renaming alone does not change the account, but warns when name and payee no longer match the company
  const named = applyFormEdit(prefillForm(blank, acme, null, new Set()), { supplierName: 'Bluejay Logistics' }, new Set());
  assert.equal(named.supplierAccount, acme.account);
  assert.equal(supplierAccountWarning(named, acme), null); // payee is still the company's
  const odd = { ...named, payee: bluejay.account };
  assert.match(supplierAccountWarning(odd, acme) ?? '', /^This is Acme Industries's account; check the supplier account matches the payee's company\.$/);
  assert.equal(supplierAccountWarning({ ...odd, supplierAccount: bluejay.account }, acme), null);
});

test('sampleInvoice: Bluejay → Acme, 2–3 lines, 0.5–1.5 USDT before GST 18 %, due in 14 days, and buildInvoice accepts it', async () => {
  const { sampleInvoice, withTax, formTotal } = await import('../lib/invoices-store.ts');
  const bluejay = { name: 'Bluejay Logistics', account: '0xc1dce946D192e344251972470237F1471C93876c' };
  const acme = { account: '0xb99A12652BEe98429ae31EA0529A0b63f1073721' };
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 200; i++) {
    const s = sampleInvoice(bluejay, acme, new Date(Date.UTC(2026, 10, 6)), rand);
    assert.ok(s.form.lines.length >= 2 && s.form.lines.length <= 3);
    const sub = formTotal(s.form);
    assert.ok(sub >= 500_000n && sub <= 1_500_000n, `subtotal ${sub}`);
    assert.equal(s.form.payee, bluejay.account);
    assert.equal(s.form.supplierAccount, bluejay.account);
    assert.equal(s.form.customer, acme.account);
    assert.equal(s.form.dueDate, '2026-11-20');
    assert.match(s.form.memo, /^PO-2026-\d{4}$/);
    assert.deepEqual([s.taxRate, s.taxLabel], ['18', 'GST']);
    assert.equal(new Set(s.form.lines.map((l) => l.description)).size, s.form.lines.length, 'no repeated line');
    const r = buildInvoice(withTax(s.form, s.taxRate, s.taxLabel), 'INV-S');
    assert.ok('invoice' in r, 'error' in r ? r.error : '');
    assert.equal(r.invoice.lines.at(-1)!.description, 'GST 18%');
    assert.equal(s.gst.hsn!.length, s.form.lines.length);
    assert.ok(s.gst.hsn!.every((h) => /^\d{6}$/.test(h)));
    assert.deepEqual([s.gst.supplierGstin, s.gst.buyerGstin, s.gst.placeOfSupply], ['27AABCB1234C1Z5', '27AACCA5678D1Z2', '27']);
  }
});

test('runCandidates: unpaid invoices of the buyer with the most of them, capped', async () => {
  const { runCandidates } = await import('../lib/invoices-store.ts');
  const mk = (id: string, customer: string) => {
    const r = buildInvoice({ ...form, customer }, id);
    assert.ok('invoice' in r);
    return { invoice: r.invoice, link: `http://x/pay/#v1.${id}`, createdAt: 1 };
  };
  const A = '0xea5a4be313e05eb254900b6adbb7d655c55242f6', B = '0xb99a12652bee98429ae31ea0529a0b63f1073721';
  const list = [mk('A1', A), mk('B1', B), mk('B2', B), mk('B3', B), mk('B4', B), mk('A2', A)];
  const paid = [{ invoice: list[2].invoice, txHash: '0x1', blockTimestamp: 1 }];
  // B2 is paid, so it is left out; B still has three unpaid against A's two
  assert.deepEqual(runCandidates(list, paid as never), { buyer: list[1].invoice.buyerAccount, links: ['http://x/pay/#v1.B1', 'http://x/pay/#v1.B3', 'http://x/pay/#v1.B4'] });
  assert.deepEqual(runCandidates(list, [], 2)!.links, ['http://x/pay/#v1.B1', 'http://x/pay/#v1.B2']);
  assert.equal(runCandidates([], []), null);
});

test('stored invoices keep their display-only GST details (and old entries without them still load)', async () => {
  const { saveInvoice, loadInvoices } = await import('../lib/invoices-store.ts');
  const r = buildInvoice(form, 'INV-G');
  assert.ok('invoice' in r);
  saveInvoice({ invoice: r.invoice, link: 'http://x/pay/#v1.g', createdAt: 1, gst: { supplierGstin: '27aabcb1234c1z5', placeOfSupply: '27' } });
  saveInvoice({ invoice: r.invoice, link: 'http://x/pay/#v1.h', createdAt: 2 });
  const [plain, withGst] = loadInvoices();
  assert.equal(plain.gst, null);
  assert.deepEqual(withGst.gst, { supplierGstin: '27AABCB1234C1Z5', placeOfSupply: '27' });
});
