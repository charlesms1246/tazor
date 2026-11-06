import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, matchCommand, moveIndex, rank, segments, type Command } from '../app/_cmdk/match.ts';

const C: Command[] = [
  { id: 'p-home', group: 'Pages', title: 'Home', keywords: ['dashboard'], href: '/' },
  { id: 'p-pol', group: 'Pages', title: 'Policies', keywords: ['limits', 'spending'], href: '/policies/' },
  { id: 'p-pay', group: 'Pages', title: 'Pay an invoice', keywords: ['payment link'], href: '/pay/' },
  { id: 'p-runs', group: 'Pages', title: 'Payment runs', keywords: ['batch'], href: '/runs/' },
  { id: 'a-new', group: 'Actions', title: 'Create invoice', href: '/invoices/' },
  { id: 'i-1', group: 'Invoices', title: 'INV-20261106-00A1', subtitle: 'Acme Industries · 1,250.00 USDT', keywords: ['Acme Industries', '1,250.00'], href: '/invoices/?open=INV-20261106-00A1' },
  { id: 'd-pol', group: 'Docs', title: 'Policies', subtitle: 'Spending limits, payee rules.', href: '/docs/policies/' },
  { id: 'd-apol', group: 'Docs', title: 'Apolitical glossary', href: '/docs/glossary/' },
];

test('matching is case-insensitive substring over title and keywords', () => {
  assert.ok(matchCommand('POL', C[1]));
  assert.ok(matchCommand('spend', C[1]), 'keyword match');
  assert.equal(matchCommand('xyz', C[1]), null);
  assert.ok(matchCommand('acme 1,250', C[5]), 'every word may match in keywords');
  assert.equal(matchCommand('acme nope', C[5]), null, 'all words must match');
});

test('scores: exact < prefix < word start < inside < keywords only', () => {
  const s = (q: string, c: Command) => matchCommand(q, c)!.score;
  assert.equal(s('home', C[0]), 0);
  assert.equal(s('hom', C[0]), 1);
  assert.equal(s('invoice', C[2]), 2);
  assert.equal(s('olic', C[1]), 3);
  assert.equal(s('dashboard', C[0]), 4);
});

test('highlight ranges prefer word starts and merge overlaps', () => {
  assert.deepEqual(matchCommand('pol', C[7])!.ranges, [[1, 4]], 'no word start, first occurrence');
  assert.deepEqual(matchCommand('in', { id: 'm', group: 'Pages', title: 'Main invoice' })!.ranges, [[5, 7]], 'word start "invoice", not "in" inside "Main"');
  assert.deepEqual(matchCommand('pay pa', C[2])!.ranges, [[0, 3]]);
  assert.deepEqual(matchCommand('spend', C[1])!.ranges, [], 'keyword-only hit has nothing to highlight');
  assert.deepEqual(segments('Policies', [[0, 3]]), [{ text: 'Pol', hit: true }, { text: 'icies', hit: false }]);
  assert.deepEqual(segments('abc', []), [{ text: 'abc', hit: false }]);
});

test('"pol" ranks the Policies page first', () => {
  const first = flatten(rank('pol', C))[0];
  assert.equal(first.cmd.href, '/policies/');
  const groups = rank('pol', C).map((s) => s.group);
  assert.deepEqual(groups, ['Pages', 'Docs']);
});

test('sections are ordered by best score; groups tie in fixed order', () => {
  assert.deepEqual(rank('inv-2026', C).map((s) => s.group), ['Invoices']);
  assert.deepEqual(rank('create', C).map((s) => s.group), ['Actions']);
  const pay = flatten(rank('pay', C)).map((h) => h.cmd.id);
  assert.deepEqual(pay.slice(0, 2), ['p-pay', 'p-runs'], 'within a group: score, then original order');
});

test('an empty query lists everything in group order with per-group caps', () => {
  const all = rank('  ', C, { emptyLimit: { Docs: 1 } });
  assert.deepEqual(all.map((s) => s.group), ['Pages', 'Actions', 'Invoices', 'Docs']);
  assert.equal(all.find((s) => s.group === 'Docs')!.hits.length, 1);
  assert.equal(all[0].hits.length, 4);
  const many: Command[] = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, group: 'Docs', title: `Doc ${i}` }));
  assert.equal(flatten(rank('doc', many)).length, 8, 'default cap with a query');
  assert.equal(flatten(rank('doc', many, { limit: 3 })).length, 3);
});

test('moveIndex wraps both ways', () => {
  assert.equal(moveIndex(0, -1, 5), 4);
  assert.equal(moveIndex(4, 1, 5), 0);
  assert.equal(moveIndex(2, 1, 5), 3);
  assert.equal(moveIndex(0, 1, 0), -1);
});
