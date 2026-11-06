import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, decodeFunctionData, defineChain, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  encodeFunctionResult, getAddress, http, parseAbi, toHex, type Address, type Hex,
} from 'viem';
import { commandProver, createWatcher, L1_BLOCK, roleCacheAbi, rolesChanged } from '../src/watcher.ts';

const ACME = getAddress('0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1');
const BLUEJAY = getAddress('0x2A582b9cFD4C20921C467512B7ebA41204d9a16b');
const ROLE_CACHE = getAddress('0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe');
const ALICE = getAddress('0x00000000000000000000000000000000000a11ce');
const BOB = getAddress('0x0000000000000000000000000000000000000b0b');
const APPROVER = 1n << 64n;
const PROOF = '0xdeadbeefcafe';
const TX = `0x${'ab'.repeat(32)}` as Hex;

type Ev = { registry: Address; account: Address; block: bigint; roles: bigint; resource?: bigint };
const state = {
  head: 1_000n,
  l2Known: 0n,
  events: [] as Ev[],
  cached: new Map<string, bigint>(),
  getLogsParams: [] as any[],
  timestamp: 1_800_000_000n,
};

const dir = mkdtempSync(join(tmpdir(), 'tazor-watcher-'));
const proverLog = join(dir, 'prover.log');
const failFlag = join(dir, 'fail');
const fakeProver = fileURLToPath(new URL('./fake-prover.mjs', import.meta.url));
process.env.FAKE_PROVER_LOG = proverLog;
process.env.FAKE_PROVER_FAIL = failFlag;
const proverRuns = () => (existsSync(proverLog) ? readFileSync(proverLog, 'utf8').trim().split('\n').filter(Boolean) : []);

const l1BlockAbi = parseAbi(['function number() view returns (uint64)']);

function rpcLog(e: Ev, i: number) {
  return {
    address: e.registry,
    topics: encodeEventTopics({ abi: [rolesChanged], eventName: 'EACRolesChanged', args: { resource: e.resource ?? 0n, account: e.account } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, e.roles]),
    blockNumber: toHex(e.block), blockHash: `0x${'11'.repeat(32)}`, transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: '0x0', logIndex: toHex(i), removed: false,
  };
}

function handler(chain: 'l1' | 'l2') {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { id, method, params } = JSON.parse(raw);
    const ok = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (method === 'eth_chainId') return ok(chain === 'l1' ? '0xaa36a7' : '0x752');
    if (chain === 'l1' && method === 'eth_blockNumber') return ok(toHex(state.head));
    if (chain === 'l1' && method === 'eth_getLogs') {
      const f = params[0];
      state.getLogsParams.push(f);
      const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map((a: string) => a.toLowerCase());
      const wantResource = f.topics?.[1];
      return ok(state.events
        .map(rpcLog)
        .filter((l, i) => {
          const e = state.events[i];
          return e.block >= from && e.block <= to && addrs.includes(l.address.toLowerCase())
            && (!wantResource || l.topics[1] === wantResource);
        }));
    }
    if (chain === 'l1' && method === 'eth_getBlockByNumber') {
      return ok({ number: params[0], hash: `0x${'33'.repeat(32)}`, timestamp: toHex(state.timestamp), transactions: [] });
    }
    if (chain === 'l2' && method === 'eth_call') {
      const { to, data } = params[0];
      if (to.toLowerCase() === L1_BLOCK.toLowerCase()) {
        return ok(encodeFunctionResult({ abi: l1BlockAbi, functionName: 'number', result: state.l2Known }));
      }
      if (to.toLowerCase() === ROLE_CACHE.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: roleCacheAbi, data });
        const k = `${getAddress(args![0] as Address)}:${getAddress(args![1] as Address)}`;
        return ok(encodeFunctionResult({ abi: roleCacheAbi, functionName: 'rolesOf', result: [0n, state.cached.get(k) ?? 0n] }));
      }
    }
    res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } }));
  });
}

let l1Server: Server, l2Server: Server, l1Url: string, l2Url: string;
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
before(async () => { l1Server = handler('l1'); l2Server = handler('l2'); l1Url = await listen(l1Server); l2Url = await listen(l2Server); });
after(() => { l1Server.close(); l2Server.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  state.head = 1_000n; state.l2Known = 0n; state.events = []; state.cached.clear(); state.getLogsParams = [];
  rmSync(proverLog, { force: true }); rmSync(failFlag, { force: true });
});

function setup() {
  const chain = (id: number, url: string) => defineChain({ id, name: 'mock', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const sent: { to: Address; data: Hex }[] = [];
  const logs: string[] = [];
  const watcher = createWatcher({
    l1: createPublicClient({ chain: chain(11155111, l1Url), transport: http(l1Url), cacheTime: 0 }),
    l2: createPublicClient({ chain: chain(1874, l2Url), transport: http(l2Url) }),
    registries: [ACME, BLUEJAY],
    roleCache: ROLE_CACHE,
    send: async (to, data) => { sent.push({ to, data }); return TX; },
    prove: commandProver(`node ${fakeProver}`),
    log: (l) => logs.push(l),
    now: () => Number(state.timestamp + 75n) * 1000,
  });
  return { watcher, sent, logs };
}

const expectedCall = (registry: Address, account: Address) =>
  encodeFunctionData({ abi: parseAbi(['function syncRoles(address,address,bytes)']), functionName: 'syncRoles', args: [registry, account, PROOF] });

test('a role change triggers exactly one syncRoles with the right calldata and log line', async () => {
  const { watcher, sent, logs } = setup();
  state.events = [{ registry: ACME, account: ALICE, block: 990n, roles: APPROVER }];
  state.l2Known = 995n;
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ROLE_CACHE);
  assert.equal(sent[0].data, expectedCall(ACME, ALICE));
  assert.deepEqual(logs, [`synced ${ACME} ${ALICE} roles=0x${APPROVER.toString(16)} tx=${TX} lag=75s`]);
  // only root-resource role changes are requested, from head - 50
  assert.equal(state.getLogsParams[0].topics[1], toHex(0n, { size: 32 }));
  assert.equal(BigInt(state.getLogsParams[0].fromBlock), 950n);
  // nothing more on the next tick
  state.head = 1_001n;
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(BigInt(state.getLogsParams[1].fromBlock), 1_001n);
});

test('it waits while Whitechain L1Block is behind the event block', async () => {
  const { watcher, sent } = setup();
  state.events = [{ registry: ACME, account: ALICE, block: 990n, roles: APPROVER }];
  state.l2Known = 989n;
  await watcher.tick();
  await watcher.tick();
  assert.equal(sent.length, 0);
  assert.deepEqual(proverRuns(), [], 'no proof built before Whitechain knows the block');
  assert.equal(watcher.pending().length, 1);
  state.l2Known = 990n;
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(watcher.pending().length, 0);
});

test('it skips when the cache already holds a proof at or after the event block', async () => {
  const { watcher, sent } = setup();
  state.events = [{ registry: BLUEJAY, account: BOB, block: 990n, roles: APPROVER }];
  state.l2Known = 999n;
  state.cached.set(`${BLUEJAY}:${BOB}`, 990n);
  await watcher.tick();
  assert.equal(sent.length, 0);
  assert.deepEqual(proverRuns(), []);
  assert.equal(watcher.pending().length, 0);
});

test('it de-duplicates (registry, account) pairs within a batch', async () => {
  const { watcher, sent, logs } = setup();
  state.events = [
    { registry: ACME, account: ALICE, block: 980n, roles: 0n },
    { registry: ACME, account: ALICE, block: 985n, roles: APPROVER },
    { registry: ACME, account: ALICE, block: 985n, roles: APPROVER | (1n << 68n) },
    { registry: BLUEJAY, account: ALICE, block: 986n, roles: APPROVER },
    { registry: ACME, account: BOB, block: 987n, roles: 5n, resource: 7n }, // not the root resource
  ];
  state.l2Known = 999n;
  await watcher.tick();
  assert.deepEqual(sent.map((s) => s.data).sort(), [expectedCall(ACME, ALICE), expectedCall(BLUEJAY, ALICE)].sort());
  assert.equal(proverRuns().length, 2);
  assert.ok(logs.some((l) => l.startsWith(`synced ${ACME} ${ALICE} roles=0x${(APPROVER | (1n << 68n)).toString(16)}`)), 'latest bitmap wins');
});

test('a prover failure is logged and retried on the next tick without crashing', async () => {
  const { watcher, sent, logs } = setup();
  state.events = [{ registry: ACME, account: ALICE, block: 990n, roles: APPROVER }];
  state.l2Known = 999n;
  writeFileSync(failFlag, '');
  await watcher.tick();
  assert.equal(sent.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^error ${ACME} ${ALICE} prover failed`));
  assert.equal(watcher.pending().length, 1);
  rmSync(failFlag);
  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data, expectedCall(ACME, ALICE));
  assert.equal(proverRuns().length, 2);
});

test('a send failure keeps the pair pending for the next tick', async () => {
  const sent: { to: Address; data: Hex }[] = [];
  const logs: string[] = [];
  let fail = true;
  const w = createWatcher({
    l1: createPublicClient({ transport: http(l1Url), cacheTime: 0 }),
    l2: createPublicClient({ transport: http(l2Url) }),
    registries: [ACME], roleCache: ROLE_CACHE,
    send: async (to, data) => { if (fail) throw new Error('simulation reverted'); sent.push({ to, data }); return TX; },
    prove: commandProver(`node ${fakeProver}`),
    log: (l) => logs.push(l),
  });
  state.events = [{ registry: ACME, account: ALICE, block: 990n, roles: APPROVER }];
  state.l2Known = 999n;
  await w.tick();
  assert.equal(sent.length, 0);
  assert.match(logs[0], /^error .* simulation reverted/);
  fail = false;
  await w.tick();
  assert.equal(sent.length, 1);
});
