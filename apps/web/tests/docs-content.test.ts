import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_DOC_PAGES, DOC_GROUPS, docHref, docPage } from '../app/docs/content.ts';

const DOCS = join(import.meta.dirname, '..', 'app', 'docs');

test('every docs page in content.ts has a page.tsx that renders it by slug', () => {
  assert.equal(DOC_GROUPS.length, 6);
  assert.equal(ALL_DOC_PAGES.length, 26);
  assert.equal(new Set(ALL_DOC_PAGES.map((p) => p.slug)).size, ALL_DOC_PAGES.length);
  for (const p of ALL_DOC_PAGES) {
    const f = join(DOCS, p.slug, 'page.tsx');
    assert.ok(existsSync(f), f);
    assert.match(readFileSync(f, 'utf8'), new RegExp(`slug="${p.slug}"`), p.slug);
    assert.ok(p.summary.endsWith('.'), `${p.slug} summary is a sentence`);
  }
  assert.equal(docHref('faq'), '/docs/faq/');
  assert.throws(() => docPage('nope'));
});

test('internal docs links and Related slugs point at real pages', () => {
  const slugs = new Set(ALL_DOC_PAGES.map((p) => p.slug));
  for (const p of ALL_DOC_PAGES) {
    const src = readFileSync(join(DOCS, p.slug, 'page.tsx'), 'utf8');
    for (const m of src.matchAll(/href="\/docs\/([a-z0-9-]+)\/"/g)) assert.ok(slugs.has(m[1]), `${p.slug} links ${m[1]}`);
    const rel = src.match(/related=\{\[([^\]]*)\]\}/);
    for (const r of rel ? [...rel[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]) : []) assert.ok(slugs.has(r), `${p.slug} related ${r}`);
  }
});
