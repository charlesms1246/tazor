import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransfers, nameOf } from '../lib/activity.ts';

const ACC = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const item = (over: object) => ({
  timestamp: '2026-11-06T08:56:25.000000Z', log_index: 1, transaction_hash: '0xaa',
  from: { hash: ACC }, to: { hash: '0xc1dce946D9a2BBF1e0c2A0B5a5E0D2e44c3d876c' }, total: { value: '100000' },
  token: { address_hash: USDT }, ...over,
});

test('parses direction, amount and dedupes by tx and log index', () => {
  const out = parseTransfers({ items: [item({}), item({}), item({ log_index: 2, from: { hash: '0xce4389ACb79463062c362fACB8CB04513fA3D8D8' }, to: { hash: ACC }, total: { value: '500000' } })] }, ACC, USDT);
  assert.equal(out.length, 2);
  assert.equal(out[0].incoming, false);
  assert.equal(out[0].amount, 100000n);
  assert.equal(out[1].incoming, true);
});

test('skips other tokens and rejects a malformed body', () => {
  assert.equal(parseTransfers({ items: [item({ token: { address_hash: '0x0000000000000000000000000000000000000001' } })] }, ACC, USDT).length, 0);
  assert.throws(() => parseTransfers({}, ACC, USDT));
});

test('names known demo accounts', () => {
  assert.equal(nameOf('0xc1dce946D9a2BBF1e0c2A0B5a5E0D2e44c3d876c'), 'bluejay.taz0r.eth');
  assert.equal(nameOf('0x0000000000000000000000000000000000000001'), null);
});
