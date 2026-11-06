import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, dueIn, mailtoHref, reminderMessage, whatsappHref } from '../lib/reminders.ts';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

test('due labels count calendar days', () => {
  const now = at(2026, 11, 7, 23);
  assert.deepEqual(dueIn(at(2026, 11, 10, 0), now), { text: 'Due in 3 days', tone: 'soon', days: 3 });
  assert.deepEqual(dueIn(at(2026, 11, 8, 1), now), { text: 'Due in 1 day', tone: 'soon', days: 1 });
  assert.deepEqual(dueIn(at(2026, 11, 7, 0), now), { text: 'Due today', tone: 'today', days: 0 });
  assert.deepEqual(dueIn(at(2026, 11, 6), now), { text: 'Overdue by 1 day', tone: 'overdue', days: -1 });
  assert.deepEqual(dueIn(at(2026, 10, 28), now), { text: 'Overdue by 10 days', tone: 'overdue', days: -10 });
  assert.equal(dueIn(at(2026, 11, 30), now).tone, 'later');
});

test('the reminder is polite and carries the amount, due date and pay link; WhatsApp and email links encode it', () => {
  const m = reminderMessage({ to: 'Acme', from: 'Bluejay Logistics', what: 'invoice INV-7', amount: '1.55', dueMs: at(2026, 11, 1), link: 'https://taz0r.eth.limo/pay/#v1.x', now: at(2026, 11, 7) });
  assert.match(m.body, /^Hello Acme,/);
  assert.match(m.body, /invoice INV-7 from Bluejay Logistics for 1\.55 USDT\. It was due on 1 Nov 2026\./);
  assert.match(m.body, /https:\/\/taz0r\.eth\.limo\/pay\/#v1\.x/);
  assert.match(m.body, /already paid, please ignore/);
  assert.equal(m.subject, 'Reminder: invoice INV-7 for 1.55 USDT (overdue)');
  assert.equal(whatsappHref('a b&c'), 'https://wa.me/?text=a%20b%26c');
  assert.equal(mailtoHref('S 1', 'B&2'), 'mailto:?subject=S%201&body=B%262');
  const noDue = reminderMessage({ from: 'X', what: 'order 9', amount: '2', dueMs: null, link: 'L' });
  assert.match(noDue.body, /^Hello,\n/);
});

test('"reminded … ago" reads naturally', () => {
  const now = 1_800_000_000_000;
  assert.equal(ago(now - 20_000, now), 'just now');
  assert.equal(ago(now - 5 * 60_000, now), '5 min ago');
  assert.equal(ago(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(ago(now - 3 * 86_400_000, now), '3 days ago');
});
