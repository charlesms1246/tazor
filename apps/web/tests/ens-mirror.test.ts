import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { ROLE_APPROVER, ensApproverState, mirrorLabel, requestMirror } from '../lib/ens-mirror.ts';

const REG = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1';
const RAVI = '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb';
const ACME = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const abi = parseAbi(['function roles(uint256 resource, address account) view returns (uint256)']);

const rpc = (roles: bigint) => (async (_u: string, init: RequestInit) => {
  const { params } = JSON.parse(String(init.body));
  assert.equal(params[0].to, REG);
  assert.deepEqual(decodeFunctionData({ abi, data: params[0].data }).args, [0n, RAVI]);
  return new Response(JSON.stringify({ result: encodeFunctionResult({ abi, functionName: 'roles', result: roles }) }));
}) as unknown as typeof fetch;

test('ENS state: mirrored once APPROVER is gone, else still on ENS, unknown on errors', async () => {
  assert.equal(await ensApproverState(REG, RAVI, { f: rpc(0n), rpcUrl: 'x' }), 'mirrored');
  assert.equal(await ensApproverState(REG, RAVI, { f: rpc(ROLE_APPROVER | 1n), rpcUrl: 'x' }), 'still-on-ens');
  assert.equal(await ensApproverState(REG, RAVI, { f: rpc(1n << 192n), rpcUrl: 'x' }), 'mirrored', 'other roles do not count');
  assert.equal(await ensApproverState('nope', RAVI, { f: rpc(0n) }), 'unknown');
  const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  assert.equal(await ensApproverState(REG, RAVI, { f: down, rpcUrl: 'x' }), 'unknown');
  assert.equal(mirrorLabel('mirrored'), 'Mirrored to ENS');
});

test('requestMirror posts {account, target} and never throws', async () => {
  let seen: unknown;
  const ok = (async (u: string, init: RequestInit) => { seen = [u, JSON.parse(String(init.body))]; return new Response(JSON.stringify({ status: 'mirrored', tx: '0x1' })); }) as unknown as typeof fetch;
  assert.deepEqual(await requestMirror('https://r.test/', ACME, RAVI, { f: ok }), { status: 'mirrored', tx: '0x1' });
  assert.deepEqual(seen, ['https://r.test/mirror', { account: ACME, target: RAVI }]);
  const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  assert.equal((await requestMirror('https://r.test', ACME, RAVI, { f: notFound })).status, 'error');
  const bad = (async () => new Response(JSON.stringify({ error: 'account and target must be addresses' }), { status: 400 })) as unknown as typeof fetch;
  assert.deepEqual(await requestMirror('https://r.test', 'x', RAVI, { f: bad }), { status: 'error', error: 'account and target must be addresses' });
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.deepEqual(await requestMirror('https://r.test', ACME, RAVI, { f: down }), { status: 'error', error: 'fetch failed' });
});
