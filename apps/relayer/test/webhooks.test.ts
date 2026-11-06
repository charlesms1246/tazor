import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWebhooks, endpointsFromEnv, sign, upstashStore, verify } from '../src/webhooks.ts';

const M = '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6';
const SECRET = 'whsec_test';

test('Tazor-Signature: t=<unix>,v1=hmac_sha256(secret, "t.body"); verify checks the MAC, rotation and the 300 s window', () => {
  const body = '{"id":"x","type":"order.paid"}';
  const h = sign(SECRET, body, 1_800_000_000);
  assert.equal(h, `t=1800000000,v1=${createHmac('sha256', SECRET).update(`1800000000.${body}`).digest('hex')}`);
  assert.equal(verify(SECRET, body, h, 1_800_000_100), true);
  assert.equal(verify(SECRET, body + ' ', h, 1_800_000_100), false, 'tampered body');
  assert.equal(verify('other', body, h, 1_800_000_100), false, 'wrong secret');
  assert.equal(verify(SECRET, body, h, 1_800_000_301), false, 'outside the 5-minute window');
  assert.equal(verify(SECRET, body, `t=1800000000,v1=00,${h.split(',')[1]}`, 1_800_000_000), true, 'any v1 may match (rotation)');
  assert.equal(verify(SECRET, body, null), false);
});

test('endpoints from WEBHOOKS_JSON: lower-cased merchant keys; invalid entries dropped', () => {
  const e = endpointsFromEnv(JSON.stringify({ [M]: { url: 'https://shop.example/hook', secret: SECRET }, nope: { url: 'https://x', secret: 's' }, [`0x${'11'.repeat(20)}`]: { url: 'ftp://x', secret: 's' } }));
  assert.deepEqual(Object.keys(e), [M.toLowerCase()]);
  assert.deepEqual(endpointsFromEnv('not json'), {});
});

test('delivery: signed POST, 3 retries with backoff on 5xx/network, no retry on 4xx, each id once, no-endpoint recorded', async () => {
  const calls: { url: string; body: string; sig: string }[] = [];
  let failures = 2;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), sig: (init.headers as Record<string, string>)['tazor-signature'] });
    if (url.includes('bad')) return new Response('', { status: 400 });
    if (failures-- > 0) throw new Error('ECONNRESET');
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const w = createWebhooks({ endpoints: { [M.toLowerCase()]: { url: 'https://shop.example/hook', secret: SECRET } }, f, now: () => 1_800_000_000_000, sleep: async (ms) => { sleeps.push(ms); } });

  const d = await w.emit({ id: 'o1:paid', type: 'order.paid', merchant: M, data: { orderId: '0x01' }, txHash: `0x${'ab'.repeat(32)}` });
  assert.equal(d!.status, 'delivered');
  assert.equal(d!.attempts, 3);
  assert.deepEqual(sleeps, [250, 500]);
  const body = JSON.parse(calls[2].body);
  assert.deepEqual(Object.keys(body), ['id', 'type', 'created', 'data', 'chainId', 'txHash', 'explorer']);
  assert.equal(body.chainId, 1874);
  assert.equal(body.explorer, `https://explorer.testnet.whitechain.io/tx/0x${'ab'.repeat(32)}`);
  assert.equal(verify(SECRET, calls[2].body, calls[2].sig, 1_800_000_000), true, 'the merchant can verify what it received');
  assert.equal(d!.rawBody, calls[2].body);
  assert.equal(verify(SECRET, d!.rawBody, d!.signature, 1_800_000_000), true, 'the recorded raw body and signature verify too');

  assert.equal(await w.emit({ id: 'o1:paid', type: 'order.paid', merchant: M, data: {} }), null, 'an id is delivered once');
  const none = await w.emit({ id: 'o2:paid', type: 'order.paid', merchant: `0x${'22'.repeat(20)}`, data: {} });
  assert.deepEqual([none!.status, none!.attempts, none!.signature], ['no-endpoint', 0, null]);

  const w2 = createWebhooks({ endpoints: { [M.toLowerCase()]: { url: 'https://bad.example', secret: SECRET } }, f, sleep: async () => {} });
  const bad = await w2.emit({ id: 'b', type: 'order.paid', merchant: M, data: {} });
  assert.deepEqual([bad!.status, bad!.attempts, bad!.httpStatus], ['failed', 1, 400]);

  assert.deepEqual((await w.recent(M)).map((x) => x.id), ['o1:paid']);
});

test('KV store (Upstash REST): SET NX claims, LPUSH + LTRIM records, LRANGE lists', async () => {
  const cmds: unknown[][] = [];
  const kv = new Map<string, string[]>();
  const claimed = new Set<string>();
  const f = (async (_url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body)) as (string | number)[];
    cmds.push(c);
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer tok');
    let result: unknown = null;
    if (c[0] === 'SET') { result = claimed.has(String(c[1])) ? null : 'OK'; claimed.add(String(c[1])); }
    if (c[0] === 'LPUSH') kv.set(String(c[1]), [String(c[2]), ...(kv.get(String(c[1])) ?? [])]);
    if (c[0] === 'LRANGE') result = kv.get(String(c[1])) ?? [];
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as unknown as typeof fetch;
  const w = createWebhooks({ endpoints: {}, store: upstashStore('https://kv.example/', 'tok', f) });
  assert.equal(w.storage, 'kv');
  await w.emit({ id: 'k1', type: 'x402.settled', merchant: M, data: { amount: '10000' } });
  assert.equal(await w.emit({ id: 'k1', type: 'x402.settled', merchant: M, data: {} }), null);
  assert.deepEqual((await w.recent(M)).map((d) => [d.id, d.type, d.status]), [['k1', 'x402.settled', 'no-endpoint']]);
  assert.deepEqual(cmds.map((c) => c[0]), ['SET', 'LPUSH', 'LTRIM', 'SET', 'LRANGE']);
  assert.deepEqual(cmds[2], ['LTRIM', `tazor:wh:${M.toLowerCase()}`, 0, 99]);
});

test('record-only endpoints (no url) and the demo merchant: signed with the secret and recorded, nothing POSTed', async () => {
  let posts = 0;
  const f = (async () => { posts++; return new Response('ok'); }) as unknown as typeof fetch;
  const { DEMO_MERCHANT, DEMO_SECRET } = await import('../src/webhooks.ts');
  const w = createWebhooks({ endpoints: { [DEMO_MERCHANT]: { secret: DEMO_SECRET } }, f, now: () => 1_800_000_000_000 });
  const d = await w.emit({ id: 'demo1', type: 'order.paid', merchant: DEMO_MERCHANT, data: { orderId: '0x01' } });
  assert.equal(d!.status, 'signed');
  assert.equal(verify('whsec_tazor_demo_test', d!.rawBody, d!.signature, 1_800_000_000), true);
  assert.equal(posts, 0);
  assert.equal(w.hasEndpoint(DEMO_MERCHANT), false, 'no URL: /webhooks/test has nothing to POST to');
  const all = createWebhooks({ endpoints: {}, demoSecret: DEMO_SECRET, now: () => 1_800_000_000_000 });
  const other = await all.emit({ id: 'o', type: 'x402.settled', merchant: M, data: {} });
  assert.equal(other!.status, 'signed');
  assert.deepEqual(Object.keys(endpointsFromEnv(JSON.stringify({ [M]: { secret: 's' } }))), [M.toLowerCase()]);
});
