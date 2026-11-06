import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
(globalThis as any).dispatchEvent = () => true;

const { recordEvent, eventsFor, elapsed, recentEvents } = await import('../lib/events.ts');
const { upsertInbox, loadInbox, pendingInbox } = await import('../lib/inbox.ts');
const { currentCompany, setCompany, companyByAccount, COMPANIES } = await import('../lib/company.ts');

beforeEach(() => store.clear());

test('events: recorded once, ordered by time, elapsed between kinds', () => {
  assert.equal(recordEvent({ subject: '0xAB', kind: 'approved', at: 2000, title: 'Approved' }), true);
  assert.equal(recordEvent({ subject: '0xab', kind: 'approved', at: 2500, title: 'Approved again' }), false);
  recordEvent({ subject: '0xab', kind: 'created', at: 1000, title: 'Created' });
  recordEvent({ subject: '0xab', kind: 'paid', at: 5600, title: 'Paid', tx: '0x1' });
  const ev = eventsFor('0xAb');
  assert.deepEqual(ev.map((e) => e.kind), ['created', 'approved', 'paid']);
  assert.equal(elapsed(ev, 'approved', 'paid'), 3.6);
  assert.equal(elapsed(ev, 'paid', 'created'), null);
  assert.equal(recentEvents(1)[0].kind, 'paid');
});

test('events: corrupt storage reads as empty', () => {
  store.set('tazor.events.v1', '{nope');
  assert.deepEqual(eventsFor('x'), []);
});

test('inbox: upsert merges and paid never reverts', () => {
  upsertInbox({ id: 'INV-1', kind: 'invoice', title: 'Bluejay · INV-1', href: '/pay/#v1.x', status: 'needs-approval' });
  upsertInbox({ id: 'inv-1', approvals: 1 });
  assert.equal(loadInbox().length, 1);
  assert.equal(loadInbox()[0].approvals, 1);
  assert.equal(pendingInbox().length, 1);
  upsertInbox({ id: 'INV-1', status: 'paid' });
  upsertInbox({ id: 'INV-1', status: 'needs-approval' });
  assert.equal(loadInbox()[0].status, 'paid');
  assert.equal(pendingInbox().length, 0);
});

test('company: defaults to Acme, switches, looks up by account', () => {
  assert.equal(currentCompany().id, 'acme');
  setCompany('bluejay');
  assert.equal(currentCompany().id, 'bluejay');
  assert.equal(companyByAccount(COMPANIES[1].account.toUpperCase().replace('0X', '0x'))?.id, 'bluejay');
});
