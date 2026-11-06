import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
process.env.NEXT_PUBLIC_RELAYER_URL = 'https://default.relayer.test/';
const { getRelayerUrl, normalizeRelayerUrl, setRelayerUrl } = await import('../lib/relayer-url.ts');

beforeEach(() => store.clear());

test('default: the build-time relayer URL (trailing slash stripped by config)', () => {
  assert.equal(getRelayerUrl(), 'https://default.relayer.test');
});

test('override: a saved https URL wins, normalised', () => {
  assert.equal(setRelayerUrl('  https://relayer.example.com/base/  '), true);
  assert.equal(getRelayerUrl(), 'https://relayer.example.com/base');
  assert.equal(setRelayerUrl('http://localhost:8787/'), true);
  assert.equal(getRelayerUrl(), 'http://localhost:8787');
  assert.equal(setRelayerUrl('http://127.0.0.1:8787'), true);
  assert.equal(getRelayerUrl(), 'http://127.0.0.1:8787');
});

test('invalid input is rejected and leaves the current value', () => {
  setRelayerUrl('https://good.example');
  for (const bad of ['http://evil.example', 'ftp://x.example', 'javascript:alert(1)', 'not a url', '', 'https://user:pw@x.example', 'https://x.example/?q=1']) {
    assert.equal(setRelayerUrl(bad), false, bad);
    assert.equal(normalizeRelayerUrl(bad), null, bad);
  }
  assert.equal(getRelayerUrl(), 'https://good.example');
});

test('a tampered stored value is ignored (falls back to the default)', () => {
  store.set('tazor.relayer.v1', 'http://evil.example');
  assert.equal(getRelayerUrl(), 'https://default.relayer.test');
});

test('clear reverts to the default', () => {
  setRelayerUrl('https://relayer.example.com');
  assert.equal(setRelayerUrl(null), true);
  assert.equal(getRelayerUrl(), 'https://default.relayer.test');
});

test('no storage at all: default, and saving reports failure', () => {
  const saved = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
  try {
    assert.equal(getRelayerUrl(), 'https://default.relayer.test');
    assert.equal(setRelayerUrl('https://relayer.example.com'), false);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
  }
});
