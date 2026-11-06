import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, endTour, nextStep, normalizePath, parseState, placeCard, prevStep, stepHere } from '../app/_tour/steps.ts';

test('nine steps, each with a data-tour selector and at most two sentences', () => {
  assert.equal(STEPS.length, 9);
  const names = STEPS.map((s) => /^\[data-tour="([a-z-]+)"\]$/.exec(s.selector)?.[1]);
  assert.deepEqual(names, ['balance', 'lanes', 'invoice-form', 'invoice-paper', 'approvals', 'pay-fallback', 'people', 'health', 'reports']);
  for (const s of STEPS) {
    assert.ok(s.path.startsWith('/') && s.path.endsWith('/'), s.path);
    assert.ok((s.body.match(/[.!?](\s|$)/g) ?? []).length <= 2, s.title);
  }
});

test('parseState tolerates junk and clamps the step', () => {
  assert.deepEqual(parseState(null), { step: 0, active: false });
  assert.deepEqual(parseState('not json'), { step: 0, active: false });
  assert.deepEqual(parseState('{"step":4,"active":true}'), { step: 4, active: true });
  assert.deepEqual(parseState('{"step":99,"active":true}'), { step: 8, active: true });
  assert.deepEqual(parseState('{"step":-3,"active":"yes"}'), { step: 0, active: false });
  assert.deepEqual(parseState('{"step":"2"}'), { step: 0, active: false });
});

test('next stays on the page when the step is here, navigates when it is not', () => {
  assert.deepEqual(nextStep({ step: 0, active: true }, '/'), { state: { step: 1, active: true }, navigate: null });
  assert.deepEqual(nextStep({ step: 1, active: true }, '/'), { state: { step: 2, active: true }, navigate: '/invoices/' });
  assert.deepEqual(nextStep({ step: 2, active: true }, '/invoices'), { state: { step: 3, active: true }, navigate: null }, 'path without trailing slash');
  assert.deepEqual(nextStep({ step: 8, active: true }, '/export/'), { state: { step: 0, active: false }, navigate: null }, 'finish ends');
});

test('back never goes below step 1 and navigates across pages', () => {
  assert.deepEqual(prevStep({ step: 0, active: true }, '/'), { state: { step: 0, active: true }, navigate: null });
  assert.deepEqual(prevStep({ step: 2, active: true }, '/invoices/'), { state: { step: 1, active: true }, navigate: '/' });
  assert.deepEqual(endTour(), { step: 0, active: false });
});

test('stepHere shows a step only when active and on its page', () => {
  assert.equal(stepHere({ step: 0, active: false }, '/'), null);
  assert.equal(stepHere({ step: 0, active: true }, '/')?.title, 'Your company account');
  assert.equal(stepHere({ step: 2, active: true }, '/'), null);
  assert.equal(stepHere({ step: 4, active: true }, '/approvals')?.selector, '[data-tour="approvals"]');
  assert.equal(normalizePath('/pay?x=1#y'), '/pay/');
  assert.equal(normalizePath(''), '/');
});

test('placeCard: below, above, right, left, centered and clamped', () => {
  const vp = { width: 1200, height: 800 };
  const card = { width: 340, height: 200 };
  assert.deepEqual(placeCard(null, card, vp), { top: 300, left: 430, side: 'center' });
  assert.equal(placeCard({ top: 100, left: 100, width: 200, height: 100 }, card, vp).side, 'bottom');
  assert.equal(placeCard({ top: 100, left: 100, width: 200, height: 100 }, card, vp).top, 214);
  assert.equal(placeCard({ top: 560, left: 100, width: 200, height: 100 }, card, vp).side, 'top');
  assert.equal(placeCard({ top: 50, left: 100, width: 300, height: 700 }, card, vp).side, 'right');
  assert.equal(placeCard({ top: 50, left: 700, width: 480, height: 700 }, card, vp).side, 'left');
  const big = placeCard({ top: 0, left: 0, width: 1200, height: 800 }, card, vp);
  assert.deepEqual(big, { top: 588, left: 430, side: 'bottom' }, 'full-screen target: card over the bottom edge');
  assert.equal(placeCard({ top: 100, left: 0, width: 20, height: 20 }, card, vp).left, 12, 'clamped to the margin');
});
