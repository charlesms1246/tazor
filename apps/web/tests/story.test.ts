import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
const { INVOICE_STEPS, RUN_STEPS, pendingSteps, recordOpened, subjectOf, inboxForInvoice } = await import('../lib/story.ts');
const { eventsFor } = await import('../lib/events.ts');
const { parseInvoice } = await import('../lib/invoice.ts');

beforeEach(() => store.clear());

const invoice = parseInvoice({
  id: 'INV-20261106-ABCD', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', amount: '1250000', dueDate: 1798675200,
  lines: [{ description: 'Freight', quantity: '1', unitPrice: '1250000' }], memo: '',
});

test('pendingSteps: in order, and a later step counts earlier ones as done', () => {
  assert.deepEqual(pendingSteps([], INVOICE_STEPS), INVOICE_STEPS.map((s) => s.label));
  assert.deepEqual(pendingSteps([{ kind: 'created' }, { kind: 'opened' }], INVOICE_STEPS), INVOICE_STEPS.slice(1).map((s) => s.label));
  assert.deepEqual(pendingSteps([{ kind: 'opened' }, { kind: 'fallback-sent' }], INVOICE_STEPS), ['Settles on Whitechain']);
  assert.deepEqual(pendingSteps([{ kind: 'paid' }], INVOICE_STEPS), []);
  assert.deepEqual(pendingSteps([{ kind: 'approved' }], RUN_STEPS), ['Run submitted', 'Settles on Whitechain']);
});

test('recordOpened: created once (at the issue date) then opened; reopening adds nothing', () => {
  const subject = subjectOf(invoice);
  assert.equal(subject, subject.toLowerCase());
  recordOpened(invoice, Date.UTC(2026, 10, 6), Date.UTC(2026, 10, 7));
  recordOpened(invoice, Date.UTC(2026, 10, 6), Date.UTC(2026, 10, 8));
  const ev = eventsFor(subject);
  assert.deepEqual(ev.map((e) => e.kind), ['created', 'opened']);
  assert.equal(ev[0].at, Date.UTC(2026, 10, 6));
  assert.equal(ev[1].at, Date.UTC(2026, 10, 7));
});

test('inboxForInvoice: keyed by the invoice hash, amount in base units', () => {
  const item = inboxForInvoice(invoice, 'http://x/pay/#v1.a.b');
  assert.equal(item.id, subjectOf(invoice));
  assert.equal(item.amount, '1250000');
  assert.equal(item.counterparty, 'Bluejay Logistics');
  assert.equal(item.kind, 'invoice');
});
