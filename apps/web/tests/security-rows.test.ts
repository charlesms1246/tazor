import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthRows } from '../app/security/rows.ts';
import type { Health } from '../lib/health.ts';

const base: Health = {
  checkedAt: 0,
  relayer: { configured: true, ok: true, url: 'https://relayer.example', ms: 120 },
  whitechain: { ok: true, block: 12345678, ageSec: 3 },
  ethereum: { ok: true, block: 12074179 },
  fallback: { ready: true, reason: 'ready reason' },
};

test('health rows: four rows with status and detail text', () => {
  const r = healthRows(base);
  assert.deepEqual(r.map((x) => x.key), ['relayer', 'whitechain', 'ethereum', 'fallback']);
  assert.equal(r[0].detail, 'https://relayer.example · 120 ms');
  assert.equal(r[1].detail, 'block 12,345,678 · 3 s ago');
  assert.equal(r[2].detail, 'block 12,074,179');
  assert.deepEqual([r[3].status, r[3].tone, r[3].detail], ['Ready', 'positive', 'ready reason']);
});

test('health rows: not set, unreachable and not ready', () => {
  const r = healthRows({ ...base, relayer: { configured: false, ok: false, url: '' }, whitechain: { ok: false }, fallback: { ready: false, reason: 'why' } });
  assert.equal(r[0].status, 'Not set');
  assert.equal(r[1].status, 'Unreachable');
  assert.deepEqual([r[3].status, r[3].tone], ['Not ready', 'warning']);
  assert.equal(healthRows({ ...base, relayer: { configured: true, ok: false, url: 'https://r' } })[0].status, 'Unreachable');
});
