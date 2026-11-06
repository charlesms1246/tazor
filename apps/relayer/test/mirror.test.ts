import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { createMirror } from '../src/mirror.ts';

const ev = parseAbi(['event ApproverRevoked(address indexed account, address indexed target, address indexed admin)']);
const reg = parseAbi(['function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)']);
const LIST = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e' as Address;
const PM = '0xe19ddf1fd417B146137A5dE6eb56c4589431540A' as Address;
const ACCOUNT = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6' as Address;
const RAVI = '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb' as Address;
const ADMIN = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as Address;
const REGISTRY = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1' as Address;

function fakes(l1Roles: bigint) {
  const topics = encodeEventTopics({ abi: ev, eventName: 'ApproverRevoked', args: { account: ACCOUNT, target: RAVI, admin: ADMIN } }) as Hex[];
  const l2 = {
    getBlockNumber: async () => 1000n,
    getLogs: async () => [{ data: '0x' as Hex, topics }],
    readContract: async () => REGISTRY,
  };
  const l1 = { readContract: async () => l1Roles };
  const sent: { to: Address; data: Hex }[] = [];
  return { l2, l1, sent, send: async (to: Address, data: Hex) => { sent.push({ to, data }); return '0xabc' as Hex; } };
}

test('a Whitechain revocation is mirrored to the company ENS registry once', async () => {
  const f = fakes(1n << 64n);
  const lines: string[] = [];
  const m = createMirror({ l2: f.l2 as never, l1: f.l1 as never, revocationLists: [{ list: LIST, paymentModule: PM }], send: f.send, log: (l) => lines.push(l) });
  await m.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, REGISTRY);
  const { args } = decodeFunctionData({ abi: reg, data: f.sent[0].data });
  assert.deepEqual(args, [1n << 64n, RAVI]);
  assert.equal(f.sent[0].data, encodeFunctionData({ abi: reg, functionName: 'revokeRootRoles', args: [1n << 64n, RAVI] }));
  assert.match(lines[0], /^mirrored revoke 0x331b.* 0xeD73.* tx=0xabc$/);
  assert.equal(m.pendingCount(), 0);
});

test('no ENS transaction when the role is already gone on Ethereum', async () => {
  const f = fakes(0n);
  const m = createMirror({ l2: f.l2 as never, l1: f.l1 as never, revocationLists: [{ list: LIST, paymentModule: PM }], send: f.send, log: () => {} });
  await m.tick();
  assert.equal(f.sent.length, 0);
});

test('a failed send stays pending and is retried', async () => {
  const f = fakes(1n << 64n);
  let n = 0;
  const m = createMirror({ l2: f.l2 as never, l1: f.l1 as never, revocationLists: [{ list: LIST, paymentModule: PM }], send: async () => { if (n++ === 0) throw new Error('rpc down'); return '0x1' as Hex; }, log: () => {} });
  await m.tick();
  assert.equal(m.pendingCount(), 1);
  await m.tick();
  assert.equal(m.pendingCount(), 0);
});
void encodeAbiParameters;
