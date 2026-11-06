import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { createHandler } from '../src/app.ts';
import { handlerFromEnv } from '../src/env.ts';
import { CHECKOUT_ROUTES, WEBHOOK_ROUTES, X402_ROUTES } from '../src/checkout/routes.ts';
import { createRoleSync, L1_BLOCK, MAX_RANGE, roleCacheAbi, type RoleSync, type ScanSummary } from '../src/sync.ts';

const ACME = getAddress('0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1');
const OTHER = getAddress('0x2A582b9cFD4C20921C467512B7ebA41204d9a16b');
const ROLE_CACHE = getAddress('0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe');
const ALICE = getAddress('0x00000000000000000000000000000000000a11ce');
const BOB = getAddress('0x0000000000000000000000000000000000000b0b');
const APPROVER = 1n << 64n;
const ADMIN = 1n << 68n;
const PROOF = '0xdeadbeefcafe' as Hex;
const TX = `0x${'ab'.repeat(32)}` as Hex;

type World = {
  head: bigint; l2Known: bigint;
  /** ENS roles of an account as a function of the L1 block (undefined = latest). */
  ens: (account: Address, block?: bigint) => bigint;
  cached: Map<string, bigint>;
  logs: { address: Address; account: Address; block: bigint; roles: bigint }[];
};

function fakes(w: World, proofBlock?: bigint) {
  const calls = { prove: [] as [Address, Address][], send: [] as { to: Address; data: Hex }[], getLogs: [] as { fromBlock: bigint; toBlock: bigint }[], ensReads: [] as (bigint | undefined)[] };
  const l1 = {
    getBlockNumber: async () => w.head,
    readContract: async (a: { functionName: string; args: [bigint, Address]; blockNumber?: bigint }) => {
      assert.equal(a.functionName, 'roles');
      assert.equal(a.args[0], 0n, 'root resource');
      calls.ensReads.push(a.blockNumber);
      return w.ens(a.args[1], a.blockNumber);
    },
    getLogs: async (a: { address: Address[]; fromBlock: bigint; toBlock: bigint; args: { resource: bigint } }) => {
      calls.getLogs.push({ fromBlock: a.fromBlock, toBlock: a.toBlock });
      assert.equal(a.args.resource, 0n);
      return w.logs
        .filter((l) => a.address.includes(l.address) && l.block >= a.fromBlock && l.block <= a.toBlock)
        .map((l) => ({ address: l.address, blockNumber: l.block, args: { account: l.account, newRoleBitmap: l.roles } }));
    },
  };
  const l2 = {
    readContract: async (a: { address: Address; functionName: string; args?: [Address, Address] }) => {
      if (a.address === L1_BLOCK && a.functionName === 'number') return w.l2Known;
      assert.equal(a.address, ROLE_CACHE);
      assert.equal(a.functionName, 'rolesOf');
      return [w.cached.get(`${a.args![0]}:${a.args![1]}`) ?? 0n, 0n] as const;
    },
  };
  const lines: string[] = [];
  let t = 0;
  const sync = createRoleSync({
    l1: l1 as never, l2: l2 as never, roleCache: ROLE_CACHE, registries: [ACME],
    prove: async (registry, account) => { calls.prove.push([registry, account]); t += 2300; return proofBlock === undefined ? PROOF : { proof: PROOF, l1Block: proofBlock }; },
    send: async (to, data) => { calls.send.push({ to, data }); return TX; },
    log: (l) => lines.push(l),
    now: () => t,
  });
  return { sync, calls, lines, tick: (ms: number) => { t += ms; } };
}

const world = (over: Partial<World> = {}): World => ({
  head: 10_000n, l2Known: 9_995n, ens: () => APPROVER, cached: new Map(), logs: [], ...over,
});

test('syncAccount: a registry outside the allowlist is not-watched, with no reads and no tx', async () => {
  const f = fakes(world());
  assert.deepEqual(await f.sync.syncAccount(OTHER, ALICE), { registry: OTHER, account: ALICE, status: 'not-watched' });
  assert.equal(f.calls.ensReads.length, 0);
  assert.equal(f.calls.send.length, 0);
});

test('syncAccount: in-sync when the cache equals ENS at the L1 block Whitechain knows; never proves or sends', async () => {
  const f = fakes(world({ cached: new Map([[`${ACME}:${ALICE}`, APPROVER]]) }));
  for (let i = 0; i < 3; i++) {
    const r = await f.sync.syncAccount(ACME, ALICE);
    assert.equal(r.status, 'in-sync');
    assert.equal(r.roles, APPROVER);
    assert.equal(r.l1Block, 9_995n);
    assert.equal(r.tx, undefined);
  }
  assert.equal(f.calls.prove.length, 0);
  assert.equal(f.calls.send.length, 0);
  assert.ok(f.calls.ensReads.includes(9_995n), 'ENS read at the L1 block Whitechain knows');
  assert.ok(f.calls.ensReads.includes(undefined), 'and at latest');
});

test('syncAccount: pending-l1 when ENS changed after the L1 block Whitechain knows; nothing sent', async () => {
  // Alice became admin at L1 block 9_998, Whitechain only knows 9_995
  const f = fakes(world({ ens: (_a, b) => (b === undefined || b >= 9_998n ? APPROVER | ADMIN : APPROVER), cached: new Map([[`${ACME}:${ALICE}`, APPROVER]]) }));
  const r = await f.sync.syncAccount(ACME, ALICE);
  assert.equal(r.status, 'pending-l1');
  assert.equal(r.roles, APPROVER);
  assert.equal(f.calls.send.length, 0);
});

test('syncAccount: a stale cache is proved and synced once, to RoleCache.syncRoles with the proof', async () => {
  const w = world({ ens: () => APPROVER | ADMIN, cached: new Map([[`${ACME}:${ALICE}`, APPROVER]]) });
  const f = fakes(w);
  const r = await f.sync.syncAccount(ACME, ALICE);
  assert.deepEqual(r, { registry: ACME, account: ALICE, status: 'synced', tx: TX, roles: APPROVER | ADMIN, l1Block: 9_995n });
  assert.deepEqual(f.calls.prove, [[ACME, ALICE]]);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0].to, ROLE_CACHE);
  const { functionName, args } = decodeFunctionData({ abi: roleCacheAbi, data: f.calls.send[0].data });
  assert.equal(functionName, 'syncRoles');
  assert.deepEqual(args, [ACME, ALICE, PROOF]);
  assert.match(f.lines[0], /^synced 0x331b.* 0x0000.*a11ce roles=0x110000000000000000 l1Block=9995 tx=0xabab.* in 2\.3s$/i);

  // once the cache holds the roles, a second call is in-sync and sends nothing
  w.cached.set(`${ACME}:${ALICE}`, APPROVER | ADMIN);
  assert.equal((await f.sync.syncAccount(ACME, ALICE)).status, 'in-sync');
  assert.equal(f.calls.send.length, 1);
});

test('scanOnce: reads the lookback window in MAX_RANGE chunks, dedupes per (registry, account), syncs each once', async () => {
  const w = world({
    ens: (a) => (a === ALICE ? APPROVER | ADMIN : APPROVER),
    cached: new Map([[`${ACME}:${BOB}`, APPROVER]]),
    logs: [
      { address: ACME, account: ALICE, block: 3_000n, roles: APPROVER },
      { address: ACME, account: ALICE, block: 9_000n, roles: APPROVER | ADMIN },
      { address: ACME, account: BOB, block: 9_500n, roles: APPROVER },
      { address: OTHER, account: BOB, block: 9_600n, roles: APPROVER }, // not watched: never even read
    ],
  });
  const f = fakes(w);
  const s = await f.sync.scanOnce({ lookback: 7_200n });
  assert.equal(s.from, 2_800n);
  assert.equal(s.to, 10_000n);
  assert.equal(f.calls.getLogs.length, Number((7_200n + MAX_RANGE) / MAX_RANGE));
  assert.ok(f.calls.getLogs.every((c) => c.toBlock - c.fromBlock < MAX_RANGE));
  assert.equal(f.calls.getLogs[0].fromBlock, 2_800n);
  assert.equal(f.calls.getLogs.at(-1)!.toBlock, 10_000n);
  for (let i = 1; i < f.calls.getLogs.length; i++) assert.equal(f.calls.getLogs[i].fromBlock, f.calls.getLogs[i - 1].toBlock + 1n);

  assert.equal(s.changes, 2);
  assert.deepEqual(s.results.map((r) => [r.account, r.status]), [[ALICE, 'synced'], [BOB, 'in-sync']]);
  assert.deepEqual(f.calls.prove, [[ACME, ALICE]]);
  assert.equal(s.deferred, 0);
});

test('scanOnce: a failing account is reported and the rest continue; the time budget defers the remainder', async () => {
  const CAROL = getAddress('0x00000000000000000000000000000000000ca201');
  const w = world({
    ens: (a) => { if (a === ALICE) throw new Error('rpc down\nstack'); return APPROVER | ADMIN; },
    logs: [ALICE, BOB, CAROL].map((account, i) => ({ address: ACME, account, block: 9_000n + BigInt(i), roles: APPROVER })),
  });
  const f = fakes(w);
  const s = await f.sync.scanOnce({ lookback: 1_000n, budgetMs: 2_000 });
  assert.deepEqual(s.results[0], { registry: ACME, account: ALICE, status: 'error', error: 'rpc down' });
  assert.equal(s.results[1].status, 'synced'); // took 2.3 s on the fake clock: over budget
  assert.equal(s.results.length, 2);
  assert.equal(s.deferred, 1);
});

// ---- routes

const fakeSync = (): RoleSync & { got: unknown[] } => {
  const got: unknown[] = [];
  return {
    got,
    registries: [ACME],
    syncAccount: async (registry, account) => {
      got.push(['sync', registry, account]);
      return { registry, account, status: 'synced', tx: TX, roles: APPROVER, l1Block: 9_995n };
    },
    scanOnce: async ({ lookback }): Promise<ScanSummary> => {
      got.push(['scan', lookback]);
      return { from: 1n, to: 2n, changes: 1, deferred: 0, results: [{ registry: ACME, account: BOB, status: 'in-sync', roles: APPROVER, l1Block: 9n }] };
    },
  };
};

const serve = async (h: ReturnType<typeof createHandler>) => {
  const server: Server = createServer(h);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

let withSync: { server: Server; base: string };
let withoutSync: { server: Server; base: string };
const rs = fakeSync();
before(async () => {
  withSync = await serve(createHandler({ roleSync: rs, cronSecret: 's3cret', chainId: 1874 }));
  withoutSync = await serve(createHandler({}));
});
after(() => { withSync.server.close(); withoutSync.server.close(); });

test('POST /sync: syncs the pair and returns status, tx and roles (bigints as strings); bad input is 400', async () => {
  const res = await fetch(`${withSync.base}/sync`, { method: 'POST', body: JSON.stringify({ registry: ACME.toLowerCase(), account: ALICE }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { status: 'synced', registry: ACME, account: ALICE, tx: TX, roles: APPROVER.toString(), l1Block: '9995' });
  assert.deepEqual(rs.got.at(-1), ['sync', ACME, ALICE]);
  for (const bad of [{}, { registry: ACME }, { registry: 'acme.taz0r.eth', account: ALICE }, { registry: ACME, account: 7 }]) {
    const r = await fetch(`${withSync.base}/sync`, { method: 'POST', body: JSON.stringify(bad) });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.deepEqual(await r.json(), { error: 'registry and account must be addresses' });
  }
  assert.equal((await fetch(`${withSync.base}/sync`, { method: 'POST', body: 'not json' })).status, 400);
});

test('GET /watch: 401 without the cron bearer, 200 with it (7200-block lookback); routes are absent without roleSync', async () => {
  assert.equal((await fetch(`${withSync.base}/watch`)).status, 401);
  assert.equal((await fetch(`${withSync.base}/watch`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(`${withSync.base}/watch`, { headers: { authorization: 'Bearer s3cret' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { from: '1', to: '2', changes: 1, deferred: 0, results: [{ status: 'in-sync', registry: ACME, account: BOB, roles: APPROVER.toString(), l1Block: '9' }] });
  assert.deepEqual(rs.got.at(-1), ['scan', 7200n]);

  const open = await serve(createHandler({ roleSync: fakeSync() }));
  assert.equal((await fetch(`${open.base}/watch?from=cron`)).status, 200, 'no CRON_SECRET: open, query ignored');
  open.server.close();

  assert.equal((await fetch(`${withoutSync.base}/watch`)).status, 404);
  assert.equal((await fetch(`${withoutSync.base}/sync`, { method: 'POST', body: JSON.stringify({ registry: ACME, account: ALICE }) })).status, 404);
});

test('GET /health reports roleSync and the watched registries; GET / describes the relayer', async () => {
  assert.deepEqual(
    await (await fetch(`${withSync.base}/health`)).json(),
    { ok: true, relayer: null, paymentModule: null, approverAccountFactory: null, revocationList: null, mandateModule: null, roleSync: true, watchRegistries: [ACME], mirrorEnabled: false, mirrorReason: 'mirror not configured', sandbox: { enabled: false, account: null, registry: null },
      checkout: { enabled: false, address: null, depositAddress: null, routes: CHECKOUT_ROUTES },
      x402: { enabled: false, networks: ['eip155:1874', 'whitechain-sepolia'], scheme: 'exact', asset: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', demoPayTo: null, routes: X402_ROUTES },
      webhooks: { enabled: false, merchants: 0, storage: null, routes: WEBHOOK_ROUTES } },
  );
  const h = await (await fetch(`${withoutSync.base}/health`)).json();
  assert.equal(h.roleSync, false);
  assert.deepEqual(h.watchRegistries, []);

  const root = await fetch(`${withSync.base}/`);
  assert.equal(root.status, 200);
  assert.deepEqual(await root.json(), { name: 'Tazor relayer', chainId: 1874, relayer: null, health: '/health', docs: 'https://taz0r.eth.limo/docs/relayer-api/' });
  assert.equal((await (await fetch(`${withoutSync.base}/`)).json()).chainId, 1874);
});

test('handlerFromEnv: role sync needs both a prover and a key; WATCH_REGISTRIES is the allowlist', () => {
  const key = `0x${'11'.repeat(32)}`;
  const prover = async () => PROOF;
  assert.equal(handlerFromEnv({ RELAYER_PRIVATE_KEY: key }).roleSync, undefined);
  assert.equal(handlerFromEnv({ WATCH_REGISTRIES: ACME }, { prover }).roleSync, undefined);
  const r = handlerFromEnv({ RELAYER_PRIVATE_KEY: key, WATCH_REGISTRIES: ` ${ACME.toLowerCase()} , ${OTHER}` }, { prover });
  assert.deepEqual(r.roleSync?.registries, [ACME, OTHER]);
  assert.equal(r.sepoliaRpc, 'https://sepolia.gateway.tenderly.co');
  assert.equal(handlerFromEnv({ RELAYER_PRIVATE_KEY: key, SEPOLIA_RPC: 'http://l1.test' }, { prover }).sepoliaRpc, 'http://l1.test');
});

test('syncAccount: never syncs a proof whose L1 block predates the latest ENS grant (pending-l1, nothing sent)', async () => {
  // grant at L1 9_993; Whitechain's L1Block says 9_995, but the prover's commit is 9_990 (before the grant)
  const ens = (_a: Address, block?: bigint) => (block === undefined || block >= 9_993n ? APPROVER : 0n);
  const stale = fakes(world({ ens }), 9_990n);
  const r = await stale.sync.syncAccount(ACME, ALICE);
  assert.deepEqual(r, { registry: ACME, account: ALICE, status: 'pending-l1', roles: 0n, l1Block: 9_990n });
  assert.equal(stale.calls.prove.length, 1);
  assert.equal(stale.calls.send.length, 0);
  assert.match(stale.lines[0], /^deferred .* proof block 9990/);

  // once the proof's block includes the grant it syncs, reporting the proven roles and block
  const fresh = fakes(world({ ens }), 9_994n);
  const ok = await fresh.sync.syncAccount(ACME, ALICE);
  assert.equal(ok.status, 'synced');
  assert.deepEqual([ok.roles, ok.l1Block], [APPROVER, 9_994n]);
  assert.equal(fresh.calls.send.length, 1);

  // a proof that would write what the cache already holds is not sent either
  const same = fakes(world({ ens: (_a, block) => (block === undefined || block >= 9_995n ? APPROVER | ADMIN : APPROVER), l2Known: 9_995n, cached: new Map([[`${ACME}:${ALICE}`, APPROVER]]) }), 9_991n);
  const r2 = await same.sync.syncAccount(ACME, ALICE);
  assert.equal(r2.status, 'pending-l1');
  assert.equal(same.calls.send.length, 0);
});
