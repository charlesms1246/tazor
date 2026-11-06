import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, toEventSelector, type Hex } from 'viem';
import { soulAbi, IS_VERIFIED_ATTRIBUTE } from '../lib/soul.ts';
import { ADDRESS_ASSIGNED_TOPIC, MAINNET_RPC, SOUL_ATTRIBUTES, WB_SOUL, ago, mainnetSoulStats, readMainnetSoul } from '../lib/soul-mainnet.ts';

const REAL = '0x0c65bb4ea28200a498e857c011a7ac9f37109729';
const ONE = '0x0000000000000000000000000000000000000001';

type Calls = { to: string; fn: string; args: readonly unknown[] }[];
function rpc(souls: Record<string, bigint>, attrs: Record<string, Hex>, calls: Calls = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    assert.equal(url, MAINNET_RPC);
    const { params } = JSON.parse(String(init.body));
    const { to, data } = params[0];
    const { functionName, args } = decodeFunctionData({ abi: soulAbi, data });
    calls.push({ to, fn: functionName, args: args ?? [] });
    const result = functionName === 'soulOf'
      ? encodeFunctionResult({ abi: soulAbi, functionName, result: souls[String(args![0]).toLowerCase()] ?? 0n })
      : encodeFunctionResult({ abi: soulAbi, functionName: 'soulAttributeValue', result: attrs[String(args![0])] ?? '0x0000000000000000000000000000000000000000' });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  }) as typeof fetch;
}

test('verified soul: soulOf on 0x2000, IsVerified on 0x2002', async () => {
  const calls: Calls = [];
  const r = await readMainnetSoul(REAL, rpc({ [REAL]: 9531n }, { 9531: ONE }, calls));
  assert.deepEqual(r, { soulId: 9531n, verified: true });
  assert.deepEqual(calls.map((c) => [c.to, c.fn]), [[WB_SOUL, 'soulOf'], [SOUL_ATTRIBUTES, 'soulAttributeValue']]);
  assert.equal(calls[1].args[1], IS_VERIFIED_ATTRIBUTE);
});

test('no soul: one call, verified false; soul without IsVerified = 1 is not verified', async () => {
  const calls: Calls = [];
  assert.deepEqual(await readMainnetSoul(REAL, rpc({}, {}, calls)), { soulId: null, verified: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(await readMainnetSoul(REAL, rpc({ [REAL]: 7n }, { 7: '0x0000000000000000000000000000000000000002' })), { soulId: 7n, verified: false });
});

test('never throws: bad address, HTTP error, RPC error, network error, timeout', async () => {
  assert.deepEqual(await readMainnetSoul('nope', rpc({}, {})), { soulId: null, verified: null, error: 'not an address' });
  const http = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
  assert.deepEqual(await readMainnetSoul(REAL, http), { soulId: null, verified: null, error: 'RPC HTTP 503' });
  const rpcErr = (async () => new Response(JSON.stringify({ error: { message: 'execution reverted' } }))) as unknown as typeof fetch;
  assert.equal((await readMainnetSoul(REAL, rpcErr)).error, 'execution reverted');
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.equal((await readMainnetSoul(REAL, down)).error, 'fetch failed');
  const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })) as unknown as typeof fetch;
  const t0 = Date.now();
  assert.deepEqual(await readMainnetSoul(REAL, hang, 50), { soulId: null, verified: null, error: 'timed out' });
  assert.ok(Date.now() - t0 < 1000);
});

const log = (topic: string, ts: string, tx: string, method = 'AddressAssigned(address indexed addr, uint256 indexed soulId)') =>
  ({ block_timestamp: ts, transaction_hash: tx, topics: [topic, null], decoded: { method_call: method } });

test('stats count AddressAssigned only and pick the newest', async () => {
  assert.equal(ADDRESS_ASSIGNED_TOPIC, toEventSelector('AddressAssigned(address,uint256)'));
  const items = [
    log(ADDRESS_ASSIGNED_TOPIC, '2026-11-02T16:08:35.000000Z', '0xb'),
    log('0x' + '11'.repeat(32), '2026-11-06T10:00:00.000000Z', '0xc', 'AddressRevoked(address indexed addr, uint256 indexed soulId)'),
    log(ADDRESS_ASSIGNED_TOPIC, '2026-11-06T09:15:07.000000Z', '0xa'),
  ];
  let url = '';
  const f = (async (u: string) => { url = u; return new Response(JSON.stringify({ items })); }) as unknown as typeof fetch;
  const s = await mainnetSoulStats(f);
  assert.equal(url, `https://explorer.whitechain.io/api/v2/addresses/${WB_SOUL}/logs`);
  assert.deepEqual(s, { assigned: 2, latestAt: Date.parse('2026-11-06T09:15:07Z'), latestTx: '0xa', link: `https://explorer.whitechain.io/address/${WB_SOUL}?tab=logs` });
});

test('stats never throw', async () => {
  const bad = (async () => new Response('not json')) as unknown as typeof fetch;
  const s = await mainnetSoulStats(bad);
  assert.equal(s.assigned, 0);
  assert.ok(s.error);
  const empty = (async () => new Response(JSON.stringify({}))) as unknown as typeof fetch;
  assert.deepEqual((await mainnetSoulStats(empty)).assigned, 0);
});

test('ago', () => {
  assert.equal(ago(0, 30_000), '30 s ago');
  assert.equal(ago(0, 5 * 60_000), '5 min ago');
  assert.equal(ago(0, 3 * 3_600_000), '3 h ago');
  assert.equal(ago(0, 2 * 86_400_000), '2 d ago');
});
