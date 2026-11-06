import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const { decide, loadDecisions, release } = await import('../lib/decisions.ts');
beforeEach(() => store.clear());

test('decisions: hold and reject need a reason, are keyed by item id (case-insensitive), and can be released', () => {
  assert.throws(() => decide('0xAB', 'hold', '  '), /Say why you are holding it/);
  assert.throws(() => decide('0xAB', 'reject', 'x'.repeat(281)), /under 280/);
  decide('0xAB', 'hold', ' Waiting for the PO from procurement ', 1000);
  decide('0xcd', 'reject', 'Duplicate of INV-7', 2000);
  assert.deepEqual(loadDecisions(), {
    '0xab': { kind: 'hold', reason: 'Waiting for the PO from procurement', at: 1000 },
    '0xcd': { kind: 'reject', reason: 'Duplicate of INV-7', at: 2000 },
  });
  release('0XAB');
  assert.deepEqual(Object.keys(loadDecisions()), ['0xcd']);
  store.set('tazor.decisions.v1', '{"0x1":{"kind":"approve","reason":"?","at":1},"0x2":"junk"}');
  assert.deepEqual(loadDecisions(), {}, 'malformed entries are ignored');
});
