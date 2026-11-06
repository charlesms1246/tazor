import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxClient, isSandboxError } from '../lib/sandbox.ts';

const fakeFetch = (routes: Record<string, [number, unknown]>, seen: { url: string; init?: RequestInit }[] = []) =>
  (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const [status, body] = routes[`${init?.method ?? 'GET'} ${new URL(url).pathname}`] ?? [404, { error: 'not found' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

test('sandbox client: posts the admit body, flat counterparty params, maps errors and missing relayer', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const c = createSandboxClient(() => 'https://relayer.example/', fakeFetch({
    'POST /sandbox/admit': [200, { ok: true, status: 'admitted', companyId: 'sandbox', account: '0xaa', txs: [], steps: [] }],
    'POST /sandbox/counterparty': [403, { ok: false, status: 'refused', error: 'nope', reason: 'nope', detail: 'nope', tx: null, chain: 'whitechain', explorerUrl: null }],
    'GET /health': [200, { ok: true, sandbox: { enabled: true, account: '0xaa', registry: '0xee' } }],
  }, seen));
  const a = await c.admit('0x0000000000000000000000000000000000000001');
  assert.equal(seen[0].url, 'https://relayer.example/sandbox/admit');
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { approver: '0x0000000000000000000000000000000000000001' });
  assert.ok(!isSandboxError(a.body) && a.body.companyId === 'sandbox');

  const r = await c.counterparty('collect', { mandate: '0x01' });
  assert.deepEqual(JSON.parse(String(seen[1].init?.body)), { mandate: '0x01', action: 'collect' });
  assert.equal(r.httpStatus, 403);
  assert.ok(isSandboxError(r.body) && r.body.reason === 'nope');

  assert.deepEqual(await c.health(), { enabled: true, account: '0xaa', registry: '0xee' });
  const s = await c.status();
  assert.ok(isSandboxError(s.body) && s.httpStatus === 404);

  const none = await createSandboxClient(() => '', fakeFetch({})).admit('0x01');
  assert.ok(isSandboxError(none.body) && /No relayer/.test(none.body.error));
});
