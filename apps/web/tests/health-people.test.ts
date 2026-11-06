import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { checkHealth } from '../lib/health.ts';
import { SYNC_GRACE_SECONDS, agoText, approverFlags, cacheAgeSeconds, labelOf, roleList, roleNames, rolesFor, uniqueAddresses, whitechainStatus, type ApproverView } from '../lib/people.ts';
import { ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN } from '../lib/policies.ts';

type Reply = (method: string, params: unknown[], url: string) => unknown;
function fakeFetch(reply: Reply): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const out = reply(body?.method ?? 'GET', body?.params ?? [], u);
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify(body ? { jsonrpc: '2.0', id: 1, result: out } : out), { status: 200 });
    } catch (e) {
      throw e;
    }
  }) as typeof fetch;
}

test('checkHealth: chains up, EnsGate deployed → fallback ready; default relayer configured, fake fetch has no route for it', async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = await checkHealth(fakeFetch((m) => {
    if (m === 'eth_getBlockByNumber') return { number: '0xbc614e', timestamp: `0x${(now - 3).toString(16)}` };
    if (m === 'eth_blockNumber') return '0xb83cc3';
    if (m === 'eth_getCode') return '0x6080';
    throw new Error(`unexpected ${m}`);
  }));
  assert.equal(h.whitechain.ok, true);
  assert.equal(h.whitechain.block, 12_345_678);
  assert.ok(h.whitechain.ageSec! >= 3 && h.whitechain.ageSec! < 10);
  assert.deepEqual(h.ethereum, { ok: true, block: 12_074_179 });
  assert.equal(h.fallback.ready, true);
  assert.match(h.fallback.reason, /EnsGate is deployed/);
  assert.equal(h.relayer.configured, true);
  assert.equal(h.relayer.url, 'https://tazor-relayer.vercel.app');
  assert.equal(h.relayer.ok, false);
});

test('checkHealth never throws: everything down, or EnsGate without code', async () => {
  const down = await checkHealth((async () => { throw new Error('network'); }) as typeof fetch);
  assert.equal(down.whitechain.ok, false);
  assert.equal(down.ethereum.ok, false);
  assert.equal(down.fallback.ready, false);
  assert.match(down.fallback.reason, /unreachable/);
  const noCode = await checkHealth(fakeFetch((m) => (m === 'eth_getCode' ? '0x' : m === 'eth_blockNumber' ? '0x1' : new Error('x'))));
  assert.equal(noCode.ethereum.ok, true);
  assert.equal(noCode.fallback.ready, false);
  assert.match(noCode.fallback.reason, /no code/);
  const rpcError = await checkHealth((async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }), { status: 200 })) as typeof fetch);
  assert.equal(rpcError.whitechain.ok, false);
});

const A = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as Address;
const view = (o: Partial<ApproverView>): ApproverView => ({ approver: A, admin: false, revoked: false, cached: null, cachedAt: null, ens: null, ...o });

test('roles, labels and statuses', () => {
  assert.deepEqual(roleList(ROLE_APPROVER | ROLE_TAZOR_ADMIN), ['Approver', 'Admin']);
  assert.deepEqual(roleList(ROLE_APPROVER | ROLE_AGENT), ['Approver', 'Agent']);
  assert.equal(roleNames(0n), 'none');
  assert.equal(roleNames(ROLE_APPROVER | ROLE_TAZOR_ADMIN), 'approver, admin');
  assert.equal(labelOf(A), 'Priya (Finance)');
  assert.equal(labelOf('0x000000000000000000000000000000000000dEaD'), '0x0000…dEaD');
  assert.equal(whitechainStatus(view({ revoked: true, cached: ROLE_APPROVER, ens: ROLE_APPROVER })), 'revoked');
  assert.equal(whitechainStatus(view({ cached: ROLE_APPROVER, ens: ROLE_APPROVER })), 'in-sync');
  assert.equal(whitechainStatus(view({ cached: ROLE_APPROVER, cachedAt: 12_076_300n, ens: 0n }), 12_076_303n), 'syncing');
  assert.equal(whitechainStatus(view({ cached: ROLE_APPROVER, cachedAt: 12_074_541n, ens: 0n }), 12_076_303n), 'out-of-sync');
  assert.equal(whitechainStatus(view({ cached: 0n, cachedAt: 12_076_300n, ens: ROLE_APPROVER }), null), 'out-of-sync');
  assert.equal(whitechainStatus(view({ cached: 0n, cachedAt: 0n, ens: ROLE_APPROVER }), 12_076_303n), 'out-of-sync');
  assert.equal(whitechainStatus(view({ revoked: null })), 'unknown');
  assert.deepEqual(rolesFor(view({ admin: true, ens: ROLE_APPROVER })), ['Approver', 'Admin']);
  assert.deepEqual(rolesFor(view({ cached: ROLE_AGENT })), ['Agent']);
  assert.equal(uniqueAddresses([A, A.toLowerCase() as Address]).length, 1);
});

test('approver flags match the approvers panel wording', () => {
  assert.deepEqual(approverFlags(view({ revoked: true, ens: ROLE_APPROVER, cached: ROLE_APPROVER })), ['Revoked on Whitechain but still listed on ENS (mirror pending)']);
  assert.deepEqual(approverFlags(view({ ens: ROLE_APPROVER, cached: 0n })), ['ENS role changed, cache stale (sync pending)']);
  assert.deepEqual(approverFlags(view({ ens: ROLE_APPROVER, cached: ROLE_APPROVER })), []);
});

test('cache age and relative time', () => {
  assert.equal(cacheAgeSeconds(12_074_541n, 12_076_303n), 1762 * 12);
  assert.equal(cacheAgeSeconds(0n, 12_076_303n), null);
  assert.equal(cacheAgeSeconds(12_076_303n, null), null);
  assert.equal(cacheAgeSeconds(10n, 5n), null);
  assert.equal(SYNC_GRACE_SECONDS, 600);
  assert.equal(agoText(30), '30 s ago');
  assert.equal(agoText(600), '~10 min ago');
  assert.equal(agoText(1762 * 12), '~6 h ago');
  assert.equal(agoText(3 * 86400), '~3 d ago');
});
