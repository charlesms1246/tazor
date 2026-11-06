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
  assert.deepEqual(r.map((x) => x.key), ['relayer', 'whitechain', 'ethereum', 'fallback', 'rolesync', 'mirror']);
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

test('role sync row: unknown, not enabled, enabled with registry count', () => {
  assert.equal(healthRows(base)[4].status, 'Unknown');
  assert.equal(healthRows({ ...base, relayer: { ...base.relayer, roleSync: false } })[4].status, 'Not enabled');
  const on = healthRows({ ...base, relayer: { ...base.relayer, roleSync: true, watchRegistries: ['0x1', '0x2'] } })[4];
  assert.deepEqual([on.status, on.tone], ['Enabled · 2 registries', 'positive']);
  assert.equal(healthRows({ ...base, relayer: { ...base.relayer, roleSync: true, watchRegistries: ['0x1'] } })[4].status, 'Enabled · 1 registry');
});

test('mirror row: unknown without a report, not authorized with the reason, enabled', () => {
  assert.equal(healthRows(base)[5].status, 'Unknown');
  const off = healthRows({ ...base, relayer: { ...base.relayer, mirrorEnabled: false, mirrorReason: 'the relayer address 0x63C4 is not an APPROVER admin' } })[5];
  assert.deepEqual([off.status, off.tone], ['Not authorized', 'warning']);
  assert.match(off.detail, /0x63C4 is not an APPROVER admin/);
  assert.deepEqual(healthRows({ ...base, relayer: { ...base.relayer, mirrorEnabled: true } })[5].status, 'Enabled');
  assert.equal(healthRows({ ...base, relayer: { configured: true, ok: false, url: 'x', mirrorEnabled: true } })[5].status, 'Unknown');
});
