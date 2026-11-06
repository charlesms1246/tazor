import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import {
  TAZ0R_REGISTRY, WHITECHAIN_MAINNET_COIN_TYPE, WHITECHAIN_SEPOLIA_COIN_TYPE, coinTypeForChain, ensLabelOf, loadDirectory, mergeCompany,
  registryEventsAbi, rootRoleAccountsFromLogs, rootRoleHoldersFromLogs, subnamesFromLogs, type RawLog,
} from '../lib/ens-directory.ts';
import { labelInfo } from '../lib/people.ts';

const CE43: Address = '0xce4389ACb79463062c362fACB8CB04513fA3D8D8';
const PRIYA: Address = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const RAVI: Address = '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb';
const MEERA: Address = '0x03C291d446b870e0B8F128681937a9eCEDa97763';
const ACME_REG: Address = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1';

let n = 0;
const registered = (label: string, owner: Address, expiry: number, block: number): RawLog => ({
  topics: encodeEventTopics({ abi: registryEventsAbi, eventName: 'LabelRegistered', args: { tokenId: BigInt(++n), labelHash: `0x${'00'.repeat(31)}${n.toString(16).padStart(2, '0')}`, sender: CE43 } }) as Hex[],
  data: encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'uint64' }], [label, owner, BigInt(expiry)]),
  block_number: block, index: 0,
});
const roles = (account: Address, bitmap: bigint, block: number, index = 0): RawLog => ({
  topics: encodeEventTopics({ abi: registryEventsAbi, eventName: 'EACRolesChanged', args: { resource: 0n, account } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, bitmap]),
  block_number: block, index,
});
const other: RawLog = { topics: ['0x9b6b420ff87c91604d447e507cbeedda5df2fa669a6b6534375e41fd3905a8d5', null], data: '0x', block_number: 1, index: 9 };

test('ENSIP-11 coin types for Whitechain', () => {
  assert.equal(coinTypeForChain(1874), 0x80000752n);
  assert.equal(WHITECHAIN_SEPOLIA_COIN_TYPE, 0x80000752n);
  assert.equal(WHITECHAIN_MAINNET_COIN_TYPE, 0x80000753n);
  assert.equal(coinTypeForChain(1), 60n);
  assert.throws(() => coinTypeForChain(2 ** 31));
});

test('subnames and role accounts from registry logs (newest-first input, unknown events ignored)', () => {
  const logs = [roles(RAVI, 0n, 30), roles(RAVI, 1n << 64n, 20), registered('acme', CE43, 1888629000, 10), registered('bluejay', CE43, 1888629000, 11), other];
  assert.deepEqual(subnamesFromLogs(logs).map((s) => [s.label, s.owner, s.expiry]), [['acme', CE43, 1888629000], ['bluejay', CE43, 1888629000]]);
  assert.deepEqual(rootRoleAccountsFromLogs(logs).map((h) => [h.account, h.roles]), [[RAVI, 0n]]);
  assert.deepEqual(rootRoleHoldersFromLogs(logs), []);
});

test('company records override the fallback; missing records are marked as fallback', () => {
  const s = subnamesFromLogs([registered('acme', CE43, 1888629000, 1)])[0];
  const ens = mergeCompany(s, ACME_REG, { name: 'Acme Corp', role: 'buyer', account: '0x0000000000000000000000000000000000000Ac1' });
  assert.deepEqual([ens.name, ens.role, ens.account, ens.fallback], ['Acme Corp', 'Buyer', '0x0000000000000000000000000000000000000Ac1', []]);
  const fb = mergeCompany(s, ACME_REG, {});
  assert.deepEqual([fb.name, fb.role, fb.account, fb.fallback], ['Acme Industries', 'Buyer', '0xb99A12652BEe98429ae31EA0529A0b63f1073721', ['name', 'role', 'account']]);
  const unknown = mergeCompany({ ...s, label: 'meridian' }, null, {});
  assert.deepEqual([unknown.name, unknown.role, unknown.account, unknown.fallback], ['meridian', null, null, []]);
});

test('loadDirectory: companies from the taz0r.eth registry, members from subnames, owners and role history', async () => {
  const logsByAddress: Record<string, RawLog[]> = {
    [TAZ0R_REGISTRY.toLowerCase()]: [registered('acme', CE43, 1888629000, 1), registered('meridian', CE43, 1888629000, 2)],
    [ACME_REG.toLowerCase()]: [registered('priya', PRIYA, 1888629000, 5), registered('contractor-meera', MEERA, 1794124872, 6), roles(PRIYA, 1n << 64n, 7), roles(RAVI, 0n, 8), roles(CE43, 1n, 9)],
  };
  const f = (async (url: string) => {
    const a = url.match(/addresses\/(0x[0-9a-fA-F]{40})\/logs/)![1].toLowerCase();
    return new Response(JSON.stringify({ items: logsByAddress[a] ?? [], next_page_params: null }), { status: 200 });
  }) as unknown as typeof fetch;
  const ens = {
    text: async (name: string, key: string) => ({ 'acme.taz0r.eth:name': 'Acme from ENS', 'acme.taz0r.eth:tazor.role': 'buyer', 'priya.acme.taz0r.eth:name': 'Priya Sharma, Finance' } as Record<string, string>)[`${name}:${key}`] ?? null,
    addr: async (name: string, coinType: bigint) => (name === 'acme.taz0r.eth' && coinType === 0x80000752n ? '0xb99A12652BEe98429ae31EA0529A0b63f1073721' as Address : name === 'priya.acme.taz0r.eth' && coinType === 60n ? PRIYA : null),
    name: async (a: Address) => (a === CE43 ? 'taz0r.eth' : null),
    subregistry: async (_r: Address, label: string) => (label === 'acme' ? ACME_REG : null),
  };
  const d = await loadDirectory({ ens, f });
  assert.deepEqual(d.companies.map((c) => [c.label, c.name, c.role, c.account, c.fallback]), [
    ['acme', 'Acme from ENS', 'Buyer', '0xb99A12652BEe98429ae31EA0529A0b63f1073721', []],
    ['meridian', 'meridian', null, null, []],
  ]);
  const m = Object.fromEntries(d.members.acme.map((x) => [x.address, x]));
  assert.deepEqual([m[PRIYA].label, m[PRIYA].source, m[PRIYA].ens, m[PRIYA].roles], ['Priya Sharma, Finance', 'ens-text', 'priya.acme.taz0r.eth', 1n << 64n]);
  assert.deepEqual([m[MEERA].label, m[MEERA].source, m[MEERA].expiry], ['contractor-meera', 'ens-owner', 1794124872]);
  assert.deepEqual([m[RAVI].label, m[RAVI].source, m[RAVI].roles], ['0xeD73…c3Cb', 'role', 0n]);
  assert.deepEqual([m[CE43].label, m[CE43].source], ['taz0r.eth', 'primary-name']);
  assert.equal(ensLabelOf(PRIYA, d), 'Priya Sharma, Finance');
  assert.equal(ensLabelOf(MEERA, d), 'contractor-meera.acme.taz0r.eth');
  assert.equal(ensLabelOf('0xb99A12652BEe98429ae31EA0529A0b63f1073721', d), 'acme.taz0r.eth');
  assert.equal(ensLabelOf(RAVI, d), null);
  assert.deepEqual(labelInfo(PRIYA, null, d), { label: 'Priya Sharma, Finance', source: 'ens' });
  assert.deepEqual(labelInfo(RAVI, null, d), { label: 'Ravi (Operations)', source: 'fallback' });
  assert.deepEqual(labelInfo('0x000000000000000000000000000000000000dEaD', null, d), { label: '0x0000…dEaD', source: 'address' });
});

test('loadDirectory rejects when the registry logs are unreadable (callers fall back)', async () => {
  const f = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(loadDirectory({ f, ens: { text: async () => null, addr: async () => null, name: async () => null, subregistry: async () => null } }), /blockscout HTTP 503/);
});
