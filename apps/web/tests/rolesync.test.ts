import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Person } from '../lib/people.ts';
import { needsAutoSync, pickAutoSync, relayerRoleSync, requestSync, stateFromResult, syncText } from '../lib/rolesync.ts';

const person = (o: Partial<Person>): Person => ({ address: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', label: 'P', roles: [], soul: 'unknown', whitechain: 'in-sync', ...o });
const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('auto-sync picks out-of-sync and stale syncing people, at most 3', () => {
  assert.equal(needsAutoSync(person({ whitechain: 'out-of-sync' })), true);
  assert.equal(needsAutoSync(person({ whitechain: 'syncing', cacheAgeSec: 36 })), false);
  assert.equal(needsAutoSync(person({ whitechain: 'syncing', cacheAgeSec: 180 })), true);
  assert.equal(needsAutoSync(person({ whitechain: 'revoked' })), false);
  assert.equal(pickAutoSync(Array.from({ length: 5 }, () => person({ whitechain: 'out-of-sync' }))).length, 3);
});

test('requestSync parses statuses and surfaces relayer errors', async () => {
  assert.deepEqual(await requestSync('https://r', '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', json(200, { status: 'synced', tx: '0xab', roles: '0' })),
    { status: 'synced', tx: '0xab', roles: '0' });
  await assert.rejects(requestSync('https://r', '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', json(400, { error: 'bad registry' })), /bad registry/);
  await assert.rejects(requestSync('https://r', '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', json(200, { status: 'weird' })), /unexpected/);
});

test('states and texts', () => {
  assert.deepEqual(stateFromResult({ status: 'synced', tx: '0x1' }), { phase: 'synced', tx: '0x1' });
  assert.equal(syncText(stateFromResult({ status: 'pending-l1' })), 'Waiting for Whitechain to see the ENS change (~1 min)');
  assert.equal(syncText(stateFromResult({ status: 'not-watched' })), 'Role sync isn’t enabled for this company’s registry');
  assert.equal(syncText({ phase: 'syncing' }), 'Syncing from ENS…');
});

test('relayerRoleSync reads /health and tolerates failures', async () => {
  assert.deepEqual(await relayerRoleSync('https://r', json(200, { ok: true, roleSync: true, watchRegistries: ['0xa'] })), { enabled: true, registries: ['0xa'] });
  assert.equal(await relayerRoleSync('https://r', json(200, { ok: true })), null);
  assert.equal(await relayerRoleSync('https://r', (async () => { throw new Error('down'); }) as typeof fetch), null);
});
