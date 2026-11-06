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
  assert.match(block, /<tazor-pay-button[\s\S]*supplier-name=[\s\S]*payee=[\s\S]*buyer=[\s\S]*lines=/);
  assert.match(block, /addEventListener\('tazor-paid'/);
  // the lines attribute is valid JSON and adds up to the total shown on the page
  const json = JSON.parse(/lines='([^']+)'/.exec(block)![1]) as { quantity?: number; unitPrice: string }[];
  const total = json.reduce((s, l) => s + (l.quantity ?? 1) * Math.round(Number(l.unitPrice) * 1e6), 0);
  assert.equal(total, 1_550_000);
  assert.match(html, /1\.55 <span class="unit">USDT<\/span>/);
});

test('the docs page shows exactly the demo integration', () => {
  const block = html.split('<!-- tazor:begin -->')[1].split('<!-- tazor:end -->')[0];
  const docs = readFileSync(new URL('../../../apps/web/app/docs/sdk/page.tsx', import.meta.url), 'utf8');
  const snippet = /const example = `([\s\S]*?)`;/.exec(docs)![1];
  const norm = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(norm(snippet), norm(block));
  assert.match(docs, new RegExp(`The whole integration: ${norm(block).length} lines`));
});
