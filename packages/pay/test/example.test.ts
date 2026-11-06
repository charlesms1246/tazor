import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../examples/merchant-demo/index.html', import.meta.url), 'utf8');

test('merchant demo: the integration is the stated number of lines (≤ 20) and uses only the public element and event', () => {
  const block = html.split('<!-- tazor:begin -->')[1]?.split('<!-- tazor:end -->')[0];
  assert.ok(block, 'markers present');
  const lines = block.split('\n').filter((l) => l.trim());
  const stated = Number(/Tazor integration: (\d+) lines/.exec(html)?.[1]);
  assert.equal(lines.length, stated, 'header count matches the block');
  assert.ok(stated <= 20);
  assert.match(block, /<script src="\.\/tazor-pay\.js"><\/script>/);
  assert.match(block, /<tazor-pay-button[\s\S]*mode="wallet"[\s\S]*merchant="0x[0-9a-fA-F]{40}"[\s\S]*amount="0\.20"[\s\S]*order-ref="BJ-1042"/);
  assert.match(block, /addEventListener\('tazor-paid'/);
  // the amount the button charges is the total shown on the page, and the line items add up to it
  const rows = [...html.matchAll(/<td class="num">(\d+)<\/td><td class="num">(\d+\.\d+)<\/td>/g)].map((m) => Number(m[1]) * Math.round(Number(m[2]) * 1e6));
  assert.equal(rows.reduce((a, b) => a + b, 0), 200_000);
  assert.match(html, /0\.20 <span class="unit">USDT<\/span>/);
});

test('the docs page shows exactly the demo integration', () => {
  const block = html.split('<!-- tazor:begin -->')[1].split('<!-- tazor:end -->')[0];
  const docs = readFileSync(new URL('../../../apps/web/app/docs/sdk/page.tsx', import.meta.url), 'utf8');
  const snippet = /const example = `([\s\S]*?)`;/.exec(docs)![1];
  const norm = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(norm(snippet), norm(block));
  assert.match(docs, new RegExp(`The whole integration: ${norm(block).length} lines`));
});
