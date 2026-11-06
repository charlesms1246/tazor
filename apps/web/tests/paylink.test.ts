import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPaylink, parsePaylink, receiptHref } from '../lib/paylink.ts';

const M = '0x6b4e065d08d2cc7723635c6df0cc5268c706cd93';

test('paylink: parses m, a, ref, n, ship, d; defaults; round-trips through buildPaylink', () => {
  const r = parsePaylink(`?m=${M}&a=12.50&ref=INV-42&n=Chai%20%26%20Co&ship=50&d=60`);
  assert.deepEqual(r, { ok: true, link: { merchant: '0x6B4E065d08D2cC7723635c6df0CC5268C706cD93', amount: '12.50', ref: 'INV-42', name: 'Chai & Co', shipAbove: '50', deadlineMinutes: 60 } });
  const d = parsePaylink(`m=${M}&a=1&ref=A1`);
  assert.deepEqual(d.ok && [d.link.name, d.link.shipAbove, d.link.deadlineMinutes], ['This business', '100', 30]);
  const url = buildPaylink({ merchant: M, amount: '0.25', ref: 'Order #7 / table 3', name: 'Bluejay Cafe', ship: '100', deadlineMinutes: 45 }, 'https://taz0r.eth.limo');
  assert.equal(url, `https://taz0r.eth.limo/paylink/?m=${M}&a=0.25&ref=Order+%237+%2F+table+3&n=Bluejay+Cafe&ship=100&d=45`);
  const back = parsePaylink(new URL(url).search);
  assert.deepEqual(back.ok && [back.link.ref, back.link.name, back.link.amount], ['Order #7 / table 3', 'Bluejay Cafe', '0.25']);
  assert.equal(receiptHref(`0x${'ab'.repeat(32)}`, 'Order #7'), `/receipt/?order=0x${'ab'.repeat(32)}&ref=Order%20%237`);
});

test('paylink: friendly errors for a bad address, amount, order number; amount capped at 1000 on testnet', () => {
  const err = (s: string) => { const r = parsePaylink(s); return r.ok ? '' : r.error; };
  assert.match(err('a=1&ref=x'), /no business address/);
  assert.match(err('m=0x123&a=1&ref=x'), /invalid business address/);
  assert.match(err(`m=${M}&a=abc&ref=x`), /no valid amount/);
  assert.match(err(`m=${M}&a=0&ref=x`), /no valid amount/);
  assert.match(err(`m=${M}&a=1.1234567&ref=x`), /no valid amount/);
  assert.match(err(`m=${M}&a=1000.01&ref=x`), /at most 1000 USDT/);
  assert.equal(parsePaylink(`m=${M}&a=1000&ref=x`).ok, true);
  assert.match(err(`m=${M}&a=1`), /no order number/);
  assert.match(err(`m=${M}&a=1&ref=${'x'.repeat(65)}`), /too long/);
  const r = parsePaylink(`m=${M}&a=1&ref=x&ship=lots&d=2`);
  assert.deepEqual(r.ok && [r.link.shipAbove, r.link.deadlineMinutes], ['100', 30], 'bad optional values fall back to the defaults');
});

test('public/tazor-pay.js is the same bundle as the merchant demo (run scripts/sync-tazor-pay.mjs after building packages/pay)', () => {
  const here = join(import.meta.dirname, '..');
  const pub = readFileSync(join(here, 'public', 'tazor-pay.js'));
  const demo = readFileSync(join(here, '..', '..', 'examples', 'merchant-demo', 'tazor-pay.js'));
  assert.ok(pub.equals(demo), 'public/tazor-pay.js differs from examples/merchant-demo/tazor-pay.js');
});
