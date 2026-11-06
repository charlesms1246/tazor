import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
(globalThis as any).dispatchEvent = () => true;

const { DEMO_INVOICES, DEMO_TX_HASHES, DEMO_MANDATES } = await import('../lib/demo-data.ts');
const { seedDemo, clearDemo, isDemoLoaded, demoInvoice, demoEvents, demoCounts } = await import('../lib/demo-seed.ts');
const { loadInvoices, saveInvoice } = await import('../lib/invoices-store.ts');
const { loadPayments, appendPayment, loadMandates } = await import('../lib/storage.ts');
const { recordEvent, recentEvents } = await import('../lib/events.ts');
const { loadInbox, pendingInbox, upsertInbox } = await import('../lib/inbox.ts');
const { invoiceHash } = await import('../lib/invoice.ts');
const { decodeInvoiceLink } = await import('../lib/invoice-link.ts');

const ORIGIN = 'https://taz0r.eth.limo';
beforeEach(() => store.clear());

test('every tx hash is 0x + 64 hex', () => {
  assert.equal(DEMO_TX_HASHES.length, 20, 'distinct hashes across invoices, fallbacks, mandates, runs and roles');
  for (const h of DEMO_TX_HASHES) assert.match(h, /^0x[0-9a-f]{64}$/, h);
  for (const e of demoEvents()) if (e.tx) assert.match(e.tx, /^0x[0-9a-f]{64}$/, e.title);
});

test('every demo invoice rebuilds to the invoiceHash the live run logged', () => {
  for (const d of DEMO_INVOICES) assert.equal(invoiceHash(demoInvoice(d)), d.invoiceHash, d.id);
});

test('the one unpaid invoice is the one the chain refused; everything else is paid', () => {
  const unpaid = DEMO_INVOICES.filter((d) => !d.paid).map((d) => d.id);
  assert.deepEqual(unpaid, ['INV-0051']);
  assert.ok(DEMO_INVOICES.find((d) => d.id === 'INV-0051')!.refused);
  assert.deepEqual(demoCounts(), { invoices: 7, payments: 6, fallbacks: 3 });
});

test('seed writes invoices with working links, payments, events, inbox and the mandate', async () => {
  assert.equal(isDemoLoaded(), false);
  assert.equal(await seedDemo(ORIGIN), true);
  assert.equal(isDemoLoaded(), true);
  const inv = loadInvoices();
  assert.equal(inv.length, 7);
  for (const s of inv) {
    assert.ok(s.link.startsWith(`${ORIGIN}/pay/#v1.`), s.link);
    assert.equal(invoiceHash(await decodeInvoiceLink(s.link)), invoiceHash(s.invoice));
  }
  assert.equal(loadPayments().length, 6);
  assert.deepEqual(pendingInbox().map((i) => i.title), ['Invoice INV-0051']);
  assert.equal(loadInbox().filter((i) => i.status === 'paid').length, 6);
  assert.deepEqual(loadMandates().map((m) => m.id), DEMO_MANDATES.map((m) => m.id));
  const titles = recentEvents(100).map((e) => e.title);
  for (const t of ['INV-0042 paid in 3.6 s', 'INV-0043 paid via Ethereum in 69 s', 'Ravi removed as approver for acme.taz0r.eth in 3.06 s', 'CFO’s roles synced from ENS to Whitechain in 84 s']) assert.ok(titles.includes(t), t);
  const fb = recentEvents(100).filter((e) => e.kind === 'fallback-sent');
  assert.ok(fb.length === 3 && fb.every((e) => e.chain === 'sepolia'));
});

test('seed is idempotent', async () => {
  await seedDemo(ORIGIN);
  const snapshot = new Map(store);
  await seedDemo(ORIGIN);
  assert.deepEqual(new Map(store), snapshot, 'second call changes nothing');
  store.delete('tazor.demo.v1');
  await seedDemo(ORIGIN);
  assert.equal(loadInvoices().length, 7, 'even without the manifest, nothing is duplicated');
  assert.equal(loadPayments().length, 6);
  assert.equal(recentEvents(500).length, demoEvents().length);
});

test('clear removes only what seed added', async () => {
  const mine = { ...demoInvoice(DEMO_INVOICES[0]), id: 'INV-MINE', amount: 5_000_000n, lines: [{ description: 'Mine', quantity: 1n, unitPrice: 5_000_000n }] };
  saveInvoice({ invoice: mine, link: `${ORIGIN}/pay/#v1.mine.key`, createdAt: 1 });
  const realTx = `0x${'ab'.repeat(32)}` as const;
  appendPayment({ invoice: mine, txHash: realTx, blockTimestamp: 2 });
  recordEvent({ subject: invoiceHash(mine).toLowerCase(), kind: 'paid', at: 3000, title: 'INV-MINE paid', tx: realTx });
  upsertInbox({ id: invoiceHash(mine).toLowerCase(), title: 'Invoice INV-MINE', href: '/pay/#v1.mine.key', status: 'needs-approval' });
  // A real payment of a demo invoice already on this device is not claimed by the seed.
  const d42 = demoInvoice(DEMO_INVOICES[0]);
  appendPayment({ invoice: d42, txHash: DEMO_INVOICES[0].paid!.tx, blockTimestamp: DEMO_INVOICES[0].paid!.at });

  await seedDemo(ORIGIN);
  assert.equal(loadInvoices().length, 8);
  assert.equal(loadPayments().length, 7);
  clearDemo();
  assert.equal(isDemoLoaded(), false);
  assert.deepEqual(loadInvoices().map((s) => s.invoice.id), ['INV-MINE']);
  assert.deepEqual(loadPayments().map((p) => p.invoice.id).sort(), ['INV-0042', 'INV-MINE']);
  assert.deepEqual(recentEvents(500).map((e) => e.title), ['INV-MINE paid']);
  assert.deepEqual(loadInbox().map((i) => i.title), ['Invoice INV-MINE']);
  assert.deepEqual(loadMandates(), []);
  clearDemo();
  assert.equal(loadInvoices().length, 1, 'clearing twice is harmless');
});

test('seed then clear leaves an empty device empty', async () => {
  await seedDemo(ORIGIN);
  clearDemo();
  for (const k of ['tazor.invoices.v1', 'tazor.payments.v1', 'tazor.events.v1', 'tazor.inbox.v1', 'tazor.mandates.v1']) assert.equal(store.get(k) ?? '[]', '[]', k);
  assert.equal(store.has('tazor.demo.v1'), false);
});
