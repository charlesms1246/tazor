import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, parseState, pathOf, satisfied, type ApiResult, type Deps, type Dom, type RunState, type Step } from '../app/_autopilot/engine.ts';
import { toResult } from '../app/_autopilot/sandbox-port.ts';
import { STORY } from '../app/_autopilot/story.ts';

const TX = `0x${'ab'.repeat(32)}`;

/** A tiny fake page: elements by testid, a path, and click handlers. */
function world() {
  const el = new Map<string, { text?: string; enabled?: boolean; attrs?: Record<string, string> }>();
  const onClick = new Map<string, () => void>();
  let path = '/';
  let clock = 0;
  let saved: string | null = null;
  const calls: string[] = [];
  const navs: string[] = [];
  const companies: string[] = [];
  let apiImpl: (name: string, args: Record<string, string>) => ApiResult = () => ({ ok: true });
  const dom: Dom = {
    path: () => path,
    exists: (t) => el.has(t),
    enabled: (t) => el.has(t) && el.get(t)!.enabled !== false,
    text: (t) => el.get(t)?.text ?? null,
    attr: (t, n) => el.get(t)?.attrs?.[n] ?? null,
    hasText: (x) => [...el.values()].some((e) => e.text?.includes(x)),
    click: (t) => { calls.push(`click:${t}`); onClick.get(t)?.(); },
    fill: (t, v) => { calls.push(`fill:${t}=${v}`); el.set(t, { ...el.get(t), text: v }); },
  };
  const deps = (reload = true): Deps => ({
    dom,
    navigate: (url) => { navs.push(url); path = pathOf(url); return reload; },
    setCompany: (id) => companies.push(id),
    api: async (n, a) => { calls.push(`api:${n}:${JSON.stringify(a)}`); return apiImpl(n, a); },
    receipt: async () => 'ok',
    save: (s) => { saved = s ? JSON.stringify(s) : null; },
    load: () => parseState(saved),
    sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); },
    now: () => clock,
  });
  return {
    el, onClick, calls, navs, companies, deps,
    setPath: (p: string) => { path = p; },
    setApi: (f: typeof apiImpl) => { apiImpl = f; },
    saved: () => parseState(saved),
    clock: () => clock,
  };
}

const settle = async (r: ReturnType<typeof createRunner>, w: ReturnType<typeof world>, pred: (s: RunState | null) => boolean, max = 5000) => {
  for (let i = 0; i < max && !pred(r.state()); i++) await w.deps().sleep(10);
  assert.ok(pred(r.state()), `state never reached: ${JSON.stringify(r.state()?.status)} ${r.state()?.error ?? ''}`);
};

test('runs fill, click, wait, capture and api in order, then finishes', async () => {
  const w = world();
  w.el.set('name', { text: '' });
  w.el.set('go', {});
  w.onClick.set('go', () => w.el.set('result', { text: `paid ${TX}`, attrs: { href: `https://x/tx/${TX}` } }));
  w.setApi(() => ({ ok: true, tx: TX, detail: 'collected' }));
  const steps: Step[] = [{
    id: 'a', title: 'A', why: 'why', actions: [
      { do: 'fill', testid: 'name', value: 'Bluejay' },
      { do: 'click', testid: 'go' },
      { do: 'waitFor', wait: { testid: 'result' }, timeout: 5000, say: 'waiting' },
      { do: 'capture', testid: 'result', as: 'pay', attr: 'href', tx: 'whitechain', say: () => 'Paid' },
      { do: 'assertChain', key: 'payTx', chain: 'whitechain' },
      { do: 'api', call: { name: 'counterparty', args: (c) => ({ action: 'collect', tx: c.payTx }) }, say: 'collecting', sim: true },
    ],
  }];
  const r = createRunner(steps, w.deps());
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'done');
  const s = r.state()!;
  assert.deepEqual(w.calls.slice(0, 2), ['fill:name=Bluejay', 'click:go']);
  assert.equal(s.ctx.payTx, TX);
  assert.deepEqual(s.done, ['a']);
  assert.ok(w.calls.includes(`api:counterparty:${JSON.stringify({ action: 'collect', tx: TX })}`));
  assert.ok(s.log.some((l) => l.kind === 'sim' && l.text === 'collecting'));
  assert.equal(s.log.filter((l) => l.tx === TX).length >= 2, true, 'capture and api lines carry the tx');
});

test('a full navigation saves first and resumes on the next page load', async () => {
  const w = world();
  const steps: Step[] = [{ id: 'nav', title: 'Nav', why: '', actions: [
    { do: 'company', id: 'bluejay' },
    { do: 'goto', path: '/invoices/' },
    { do: 'log', text: 'arrived' },
  ] }];
  const r1 = createRunner(steps, w.deps(true));
  r1.start('presenter');
  await settle(r1, w, () => w.navs.length === 1);
  await w.deps().sleep(50);
  const saved = w.saved()!;
  assert.equal(saved.status, 'running');
  assert.equal(saved.action, 2, 'the goto is already counted');
  assert.ok(!saved.log.some((l) => l.text === 'arrived'), 'nothing ran after the navigation');
  assert.deepEqual(w.companies, ['bluejay']);

  const r2 = createRunner(steps, w.deps(true));   // new page: a fresh runner reads the saved state
  r2.resume();
  await settle(r2, w, (s) => s?.status === 'done');
  assert.ok(r2.state()!.log.some((l) => l.text === 'arrived'));
  assert.equal(w.navs.length, 1, 'already on /invoices/, no second navigation');
});

test('goto on the current page without a hash is a no-op; a hash change does not unload', async () => {
  const w = world();
  w.setPath('/pay/');
  const steps: Step[] = [{ id: 'x', title: 'X', why: '', actions: [{ do: 'goto', path: '/pay/' }, { do: 'goto', path: '/pay/#v1.a.b' }, { do: 'log', text: 'same page' }] }];
  const r = createRunner(steps, w.deps(false));
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'done');
  assert.deepEqual(w.navs, ['/pay/#v1.a.b']);
});

test('userTap waits for the person, then continues on the next page state', async () => {
  const w = world();
  w.el.set('approve', {});
  const steps: Step[] = [{ id: 't', title: 'T', why: '', actions: [
    { do: 'userTap', testid: 'approve', prompt: 'Your turn: tap Approve', until: { testid: 'my-approval' } },
    { do: 'log', text: 'after tap' },
  ] }];
  const r = createRunner(steps, w.deps());
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'waiting-user');
  assert.equal(r.state()!.prompt, 'Your turn: tap Approve');
  assert.equal(r.state()!.highlight, 'approve');
  assert.equal(w.calls.length, 0, 'the engine never taps for the person');
  await w.deps().sleep(2000);
  assert.equal(r.state()!.status, 'waiting-user');
  w.el.set('my-approval', { text: '{}' });
  await settle(r, w, (s) => s?.status === 'done');
  assert.equal(r.state()!.prompt, undefined);
  assert.ok(r.state()!.log.some((l) => l.text === 'after tap'));
});

test('pause holds the run (paused time does not count against timeouts); resume continues', async () => {
  const w = world();
  const steps: Step[] = [{ id: 'p', title: 'P', why: '', actions: [{ do: 'waitFor', wait: { testid: 'late' }, timeout: 1000, say: 'waiting' }, { do: 'log', text: 'late arrived' }] }];
  const r = createRunner(steps, w.deps());
  r.start('presenter');
  await w.deps().sleep(20);
  r.pause();
  await w.deps().sleep(5000);
  assert.equal(r.state()!.status, 'paused');
  w.el.set('late', {});
  r.play();
  await settle(r, w, (s) => s?.status === 'done');
});

test('a timeout fails the step; retry restarts it; skip moves on; stop clears', async () => {
  const w = world();
  const steps: Step[] = [
    { id: 'one', title: 'One', why: '', actions: [{ do: 'click', testid: 'missing', timeout: 500 }] },
    { id: 'two', title: 'Two', why: '', actions: [{ do: 'log', text: 'two ran' }] },
  ];
  const r = createRunner(steps, w.deps());
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'failed');
  assert.match(r.state()!.error!, /Timed out waiting for "missing" to be ready/);
  w.el.set('missing', {});
  r.retry();
  await settle(r, w, (s) => s?.status === 'done');
  assert.deepEqual(r.state()!.done, ['one', 'two']);

  w.el.delete('missing');
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'failed');
  r.skip();
  await settle(r, w, (s) => s?.status === 'done');
  assert.deepEqual(r.state()!.done, ['two']);
  r.stop();
  assert.equal(r.state(), null);
  assert.equal(w.saved(), null);
});

test('expectRefusal passes on a refusal and fails on success; mode filters steps and actions', async () => {
  const w = world();
  w.setApi((n, a) => (a.action === 'ravi-pays' ? { ok: false, error: 'approver revoked' } : { ok: true }));
  const steps: Step[] = [
    { id: 'g', title: 'Guest only', why: '', modes: ['guest'], actions: [{ do: 'log', text: 'guest' }] },
    { id: 'r', title: 'Ravi', why: '', actions: [
      { do: 'log', mode: 'guest', text: 'guest action' },
      { do: 'api', call: { name: 'counterparty', args: () => ({ action: 'ravi-pays' }) }, say: 'Ravi pays', expectRefusal: true },
    ] },
  ];
  const r = createRunner(steps, w.deps());
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'done');
  const log = r.state()!.log.map((l) => l.text);
  assert.ok(!log.includes('guest') && !log.includes('guest action'));
  assert.ok(log.some((t) => t === 'Refused, as it should be: approver revoked'));

  w.setApi(() => ({ ok: true }));
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'failed');
  assert.match(r.state()!.error!, /should have been refused/);
});

test('openTab waits for the click on the panel link', async () => {
  const w = world();
  const r = createRunner([{ id: 'o', title: 'Shop', why: '', actions: [{ do: 'openTab', url: 'https://bluejay-shop.vercel.app', prompt: 'Open the shop' }] }], w.deps());
  r.start('presenter');
  await settle(r, w, (s) => s?.status === 'waiting-user');
  assert.equal(r.state()!.link, 'https://bluejay-shop.vercel.app');
  r.ack();
  await settle(r, w, (s) => s?.status === 'done');
});

test('helpers: satisfied, parseState, toResult', () => {
  const w = world();
  w.el.set('a', { text: 'Relayer Unreachable', enabled: false });
  assert.equal(satisfied({ textIn: ['a', 'Unreachable'] }, w.deps().dom, {}), true);
  assert.equal(satisfied({ enabled: 'a' }, w.deps().dom, {}), false);
  assert.equal(parseState('nope'), null);
  assert.equal(parseState(JSON.stringify({ v: 2 })), null);
  assert.deepEqual(toResult(200, { txHash: TX, detail: 'ok' }).tx, TX);
  assert.equal(toResult(200, { status: 'refused', reason: 'revoked' }).ok, false);
  assert.equal(toResult(200, { status: 'refused', reason: 'revoked' }).error, 'revoked');
  assert.equal(toResult(500, null).error, 'HTTP 500');
  assert.deepEqual(toResult(200, { company: { id: 'sandbox', account: '0x1', registry: '0x2' } }).data, { buyerCompany: 'sandbox', buyerAccount: '0x1', mandateAccount: '0x1', registry: '0x2' });
});

test('the story: unique ids, a why for every step, every userTap waits on a page state', () => {
  assert.equal(new Set(STORY.map((s) => s.id)).size, STORY.length);
  assert.equal(STORY.filter((s) => s.id !== 'ready').length, 15);
  for (const s of STORY) {
    assert.ok(s.why.length > 10, s.id);
    for (const a of s.actions) if (a.do === 'userTap') assert.ok(Object.keys(a.until).length > 0, s.id);
  }
});

test('the Autopilot never targets acme: no acme accounts or registry in its sources, and both modes admit to the sandbox', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(import.meta.dirname, '..', 'app', '_autopilot');
  for (const f of ['story.ts', 'browser.ts', 'engine.ts', 'sandbox-port.ts', 'panel.tsx']) {
    const src = readFileSync(join(dir, f), 'utf8').toLowerCase();
    for (const a of ['0xb99a12652bee98429ae31ea0529a0b63f1073721', '0x18d15b034c645dbbfcb9c68238a14d059f632513', '0x331bdb575a72fb3dd8a6c85b6c043a753340fbf1', '0xea5a4be313e05eb254900b6adbb7d655c55242f6']) {
      assert.ok(!src.includes(a), `${f} mentions ${a}`);
    }
  }
  const ready = STORY.find((s) => s.id === 'ready')!;
  const admit = ready.actions.find((a) => a.do === 'api' && a.call.name === 'sandbox-admit')!;
  assert.equal(admit.mode, undefined, 'admit runs in both modes');
  const companies = STORY.flatMap((s) => s.actions).filter((a) => a.do === 'company').map((a) => (a.do === 'company' ? a.id : ''));
  assert.ok(!companies.includes('acme'));
});

test('api retry repeats an idempotent call while pending-sync, then continues; gives up after maxMs', async () => {
  const w = world();
  let n = 0;
  w.setApi(() => (++n < 4 ? { ok: true, status: 'pending-sync' } : { ok: true, status: 'admitted', data: { buyerAccount: '0x1' } }));
  const steps: Step[] = [{ id: 'adm', title: 'Admit', why: '', actions: [
    { do: 'api', call: { name: 'sandbox-admit' }, say: 'admitting', retry: { while: (r) => r.status === 'pending-sync', everyMs: 10_000, maxMs: 180_000, say: 'Waiting for Whitechain to see your new role (~1 min)…' } },
  ] }];
  const r = createRunner(steps, w.deps());
  r.start('guest');
  await settle(r, w, (s) => s?.status === 'done');
  assert.equal(n, 4);
  assert.equal(r.state()!.ctx.buyerAccount, '0x1');
  assert.equal(r.state()!.log.filter((l) => l.text.startsWith('Waiting for Whitechain')).length, 1, 'the waiting line is shown once');
  assert.ok(w.clock() >= 30_000);

  w.setApi(() => ({ ok: true, status: 'pending-sync' }));
  r.start('guest');
  await settle(r, w, (s) => s?.status === 'failed', 20_000);
  assert.match(r.state()!.error!, /Timed out after 180 s: Waiting for Whitechain/);
});

test('sandbox port: 429 gives a plain wait message; the lib/sandbox client adapts', async () => {
  const { fromClient } = await import('../app/_autopilot/sandbox-port.ts');
  assert.equal(toResult(429, { ok: false, error: 'rate limited', retryAfterSec: 600 } as never).error, 'Too many new guests right now; try again in 10 min');
  assert.equal(toResult(429, null).error, 'Too many new guests right now; try again in a few min');
  const port = fromClient({
    admit: async () => ({ httpStatus: 200, body: { ok: true, status: 'pending-sync', companyId: 'sandbox', account: '0x1', registry: '0x2', supplier: '0x3', mandateAccount: '0x1', txs: [TX] } }),
    counterparty: async () => ({ httpStatus: 200, body: { ok: false, status: 'refused', reason: 'approver revoked', tx: null } }),
  });
  const a = await port.admit('0xa');
  assert.equal(a.ok, true);
  assert.equal(a.status, 'pending-sync');
  assert.deepEqual(a.txs, [TX]);
  assert.deepEqual(a.data, { buyerCompany: 'sandbox', buyerAccount: '0x1', mandateAccount: '0x1', registry: '0x2', supplierAccount: '0x3' });
  const c = await port.counterparty('ravi-pays', {});
  assert.deepEqual([c.ok, c.error], [false, 'approver revoked']);
});

test('story: every invoice is small, the mandate cap is under the two-approver threshold', async () => {
  const { totalOf, MAX_PAYMENT } = await import('../app/_autopilot/story.ts');
  assert.equal(totalOf('0.20 USDT'), 0.2);
  assert.ok(Number.isNaN(totalOf(null)));
  const fills = STORY.flatMap((s) => s.actions).filter((a) => a.do === 'fill');
  const prices = fills.filter((a) => a.do === 'fill' && a.testid.startsWith('inv-line-price-')).map((a) => (a.do === 'fill' && typeof a.value === 'string' ? Number(a.value) : NaN));
  assert.ok(prices.length > 0 && prices.every((p) => p > 0));
  // two lines per invoice, plus 18 % GST, twice for a run
  assert.ok(2 * (0.12 + 0.05) * 1.18 <= MAX_PAYMENT);
  const cap = fills.find((a) => a.do === 'fill' && a.testid === 'm-cap');
  assert.ok(cap && cap.do === 'fill' && Number(cap.value) <= MAX_PAYMENT);
  const payees = fills.filter((a) => a.do === 'fill' && ['inv-payee', 'inv-supplier-account', 'm-payee'].includes(a.testid));
  assert.equal(payees.length >= 3, true);
  for (const p of payees) assert.ok(p.do === 'fill' && typeof p.value === 'function' && p.value({ supplierAccount: '0xS' }) === '0xS', 'payee is the sandbox supplier');
});

test('story reads raw values from attributes, never from the readable text', () => {
  const caps = STORY.flatMap((s) => s.actions).filter((a) => a.do === 'capture');
  const attrOf = (testid: string) => caps.filter((a) => a.do === 'capture' && a.testid === testid).map((a) => (a.do === 'capture' ? `${a.attr ?? 'text'}${a.inner ? ` in ${a.inner}` : ''}` : ''));
  assert.deepEqual([...new Set(attrOf('inv-link'))], ['data-link']);
  assert.deepEqual(attrOf('approver-account'), ['data-value']);
  assert.deepEqual(attrOf('m-digest'), ['data-value']);
  assert.deepEqual(attrOf('m-tx'), ['href in a']);
  assert.deepEqual(attrOf('run-tx'), ['href in a']);
  assert.deepEqual([...new Set(attrOf('pay-success-tx'))], ['href']);
});
