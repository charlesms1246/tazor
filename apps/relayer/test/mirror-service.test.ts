import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { decodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { ROLE_APPROVER, ROLE_APPROVER_ADMIN, createMirrorService } from '../src/mirror-service.ts';
import { createHandler } from '../src/app.ts';

const LIST1 = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e' as Address;
const PM1 = '0xe19ddf1fd417B146137A5dE6eb56c4589431540A' as Address;
const LIST2 = '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a' as Address;
const PM2 = '0x906620D82e2959351c81D731C67EA46DF71E36f3' as Address;
const ACME = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6' as Address;
const STRANGER = '0x000000000000000000000000000000000000bEEF' as Address;
const RAVI = '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb' as Address;
const PRIYA = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as Address;
const REGISTRY = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1' as Address;
const OTHER_REG = '0x2A582b9cFD4C20921C467512B7ebA41204d9a16b' as Address;
const SENDER = '0xce4389ACb79463062c362fACB8CB04513fA3D8D8' as Address;
const reg = parseAbi(['function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)']);

type State = { registryOf: Record<string, Address>; revoked: Set<string>; ensRoles: Record<string, bigint>; logs?: { account: Address; target: Address }[] };
const lc = (a: string) => a.toLowerCase();

function fakes(s: State, opts: { senderAdmin?: boolean } = {}) {
  const sent: { to: Address; data: Hex }[] = [];
  const l2 = {
    getBlockNumber: async () => 25_000n,
    getLogs: async ({ address, fromBlock, toBlock }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
      assert.ok(toBlock - fromBlock < 10_000n, 'chunked');
      return address === LIST1 && fromBlock === 15_000n ? (s.logs ?? []).map((args) => ({ args })) : [];
    },
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: [Address, Address] }) => {
      if (functionName === 'registryOf') return address === PM1 ? s.registryOf[lc(args[0])] ?? zeroAddress : zeroAddress;
      if (functionName === 'isRevoked') return address === LIST1 && s.revoked.has(lc(`${args[0]}:${args[1]}`));
      throw new Error(functionName);
    },
  };
  const l1 = {
    readContract: async ({ address, args }: { address: Address; args: [bigint, Address] }) => {
      if (lc(args[1]) === lc(SENDER)) return opts.senderAdmin === false || address === OTHER_REG ? 0n : ROLE_APPROVER_ADMIN | 1n;
      return s.ensRoles[lc(args[1])] ?? 0n;
    },
  };
  const sender = { address: SENDER, send: async (to: Address, data: Hex) => { sent.push({ to, data }); return `0x${'aa'.repeat(32)}` as Hex; } };
  return { l1, l2, sender, sent };
}

const svc = (f: ReturnType<typeof fakes>, registries = [REGISTRY], withSender = true) => createMirrorService({
  l1: f.l1 as never, l2: f.l2 as never, lists: [{ list: LIST1, paymentModule: PM1 }, { list: LIST2, paymentModule: PM2 }], registries,
  sender: withSender ? f.sender : undefined, lookback: 10_000n,
});

const base = (): State => ({ registryOf: { [lc(ACME)]: REGISTRY }, revoked: new Set([lc(`${ACME}:${RAVI}`)]), ensRoles: { [lc(RAVI)]: ROLE_APPROVER, [lc(PRIYA)]: ROLE_APPROVER } });

test('mirrors a revoked approver who still holds APPROVER on ENS', async () => {
  const f = fakes(base());
  const r = await svc(f).mirrorOne(ACME, RAVI);
  assert.equal(r.status, 'mirrored');
  assert.equal(r.registry, REGISTRY);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, REGISTRY);
  assert.deepEqual(decodeFunctionData({ abi: reg, data: f.sent[0].data }).args, [ROLE_APPROVER, RAVI]);
});

test('sends nothing unless revoked, watched, still on ENS and authorized', async () => {
  const s = base();
  let f = fakes(s);
  assert.equal((await svc(f).mirrorOne(ACME, PRIYA)).status, 'not-revoked');
  assert.equal((await svc(f).mirrorOne(STRANGER, RAVI)).status, 'not-a-company');
  assert.equal((await svc(f, [OTHER_REG]).mirrorOne(ACME, RAVI)).status, 'not-watched');
  f = fakes({ ...s, ensRoles: {} });
  assert.equal((await svc(f).mirrorOne(ACME, RAVI)).status, 'already-mirrored');
  f = fakes(s, { senderAdmin: false });
  assert.equal((await svc(f).mirrorOne(ACME, RAVI)).status, 'not-authorized');
  f = fakes(s);
  assert.equal((await svc(f, [REGISTRY], false).mirrorOne(ACME, RAVI)).status, 'not-authorized');
  assert.equal(f.sent.length, 0);
});

test('health explains when mirroring is off', async () => {
  assert.deepEqual(await svc(fakes(base())).health(), { mirrorEnabled: true, sender: SENDER, authorized: [REGISTRY] });
  const off = await svc(fakes(base(), { senderAdmin: false })).health();
  assert.equal(off.mirrorEnabled, false);
  assert.match(off.reason!, /not an APPROVER admin/);
  assert.match((await svc(fakes(base()), [REGISTRY], false).health()).reason!, /RELAYER_PRIVATE_KEY/);
  assert.match((await svc(fakes(base()), []).health()).reason!, /WATCH_REGISTRIES/);
  const partial = await svc(fakes(base()), [REGISTRY, OTHER_REG]).health();
  assert.equal(partial.mirrorEnabled, true);
  assert.match(partial.reason!, /1 of 2/);
});

test('scan mirrors each revoked pair from recent logs once', async () => {
  const s = { ...base(), logs: [{ account: ACME, target: RAVI }, { account: ACME, target: RAVI }, { account: ACME, target: PRIYA }] };
  const f = fakes(s);
  const out = await svc(f).scanOnce();
  assert.equal(out.from, '15000');
  assert.equal(out.to, '25000');
  assert.deepEqual(out.results.map((r) => r.status), ['mirrored', 'not-revoked']);
  assert.equal(f.sent.length, 1);
});

async function serve(handler: ReturnType<typeof createHandler>) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('POST /mirror, GET /watch and /health expose the mirror', async () => {
  const f = fakes({ ...base(), logs: [{ account: ACME, target: RAVI }] });
  const s = await serve(createHandler({ mirror: svc(f) }));
  try {
    const post = (b: unknown) => fetch(`${s.url}/mirror`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post({ account: 'nope', target: RAVI })).status, 400);
    const r = await (await post({ account: ACME, target: RAVI })).json();
    assert.equal(r.status, 'mirrored');
    assert.equal(r.tx, `0x${'aa'.repeat(32)}`);
    const h = await (await fetch(`${s.url}/health`)).json();
    assert.equal(h.mirrorEnabled, true);
    assert.deepEqual(h.mirrorRegistries, [REGISTRY]);
    const w = await (await fetch(`${s.url}/watch`)).json();
    assert.equal(w.mirror.results[0].status, 'mirrored');
  } finally { s.close(); }

  const g = await serve(createHandler({ mirror: svc(fakes(base(), { senderAdmin: false })) }));
  try {
    const r = await (await fetch(`${g.url}/mirror`, { method: 'POST', body: JSON.stringify({ account: ACME, target: RAVI }) })).json();
    assert.equal(r.status, 'not-authorized');
    assert.match(r.reason, /not an APPROVER admin/);
    const h = await (await fetch(`${g.url}/health`)).json();
    assert.equal(h.mirrorEnabled, false);
    assert.match(h.mirrorReason, /grant/);
  } finally { g.close(); }

  const none = await serve(createHandler({}));
  try {
    assert.equal((await fetch(`${none.url}/mirror`, { method: 'POST', body: '{}' })).status, 404);
    const h = await (await fetch(`${none.url}/health`)).json();
    assert.equal(h.mirrorEnabled, false);
  } finally { none.close(); }
});
