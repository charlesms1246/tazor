import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
(globalThis as any).dispatchEvent = () => true;
const { OFFLINE_RELAYER, isRelayerSimulatedOff, restoreRelayer, simulateRelayerDown } = await import('../lib/relayer-off.ts');
const { getRelayerUrl, hasRelayerOverride, setRelayerUrl } = await import('../lib/relayer-url.ts');

beforeEach(() => store.clear());

test('simulate down then back on restores the build default', () => {
  const def = getRelayerUrl();
  assert.equal(isRelayerSimulatedOff(), false);
  assert.equal(simulateRelayerDown(), true);
  assert.equal(getRelayerUrl(), OFFLINE_RELAYER);
  assert.equal(isRelayerSimulatedOff(), true);
  assert.equal(simulateRelayerDown(), true, 'idempotent');
  restoreRelayer();
  assert.equal(getRelayerUrl(), def);
  assert.equal(hasRelayerOverride(), false);
  assert.equal(isRelayerSimulatedOff(), false);
});

test('a relayer chosen on this device comes back after the simulation', () => {
  setRelayerUrl('https://my-relayer.example');
  simulateRelayerDown();
  simulateRelayerDown();
  restoreRelayer();
  assert.equal(getRelayerUrl(), 'https://my-relayer.example');
});

test('typing the offline URL by hand is not mistaken for the simulation', () => {
  setRelayerUrl(OFFLINE_RELAYER);
  assert.equal(isRelayerSimulatedOff(), false);
});
