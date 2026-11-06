import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import { IS_VERIFIED_ATTRIBUTE, soulAbi, verifyCompany } from '../lib/soul.ts';

const PM: Address = '0xe19ddf1fd417B146137A5dE6eb56c4589431540A';
const MIRROR: Address = '0x9822650A99bD33F29E383345F570dAE1e4E00928';
const COMPANY: Address = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const PRIYA: Address = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const CFO: Address = '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967';

function chain(state: { registry: Address; signers: Hex[]; souls: Record<string, bigint>; verified: Record<string, Hex> }) {
  const calls: string[] = [];
  const call = async (to: Address, data: Hex): Promise<Hex> => {
    const { functionName, args } = decodeFunctionData({ abi: soulAbi, data });
    calls.push(`${functionName}@${to}`);
    const r = (result: unknown) => encodeFunctionResult({ abi: soulAbi, functionName, result } as never);
    if (functionName === 'registryOf') return r(state.registry);
    if (functionName === 'getSigners') return r(state.signers);
    if (functionName === 'soulOf') return r(state.souls[(args![0] as string).toLowerCase()] ?? 0n);
    assert.equal(args![1], IS_VERIFIED_ATTRIBUTE);
    return r(state.verified[String(args![0])] ?? '0x0000000000000000000000000000000000000000');
  };
  return { call, calls };
}

const ONE: Hex = '0x0000000000000000000000000000000000000001';

test('verified when a company admin is a verified soul', async () => {
  const { call } = chain({ registry: '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', signers: [PRIYA, CFO], souls: { [CFO.toLowerCase()]: 2n }, verified: { 2: ONE } });
  assert.deepEqual(await verifyCompany(COMPANY, { paymentModule: PM, mirror: MIRROR, call }), { verified: true, admin: CFO, soulId: 2n });
});

test('not verified: not a Tazor company, soul without IsVerified, or passkey-only signers', async () => {
  const notCompany = chain({ registry: '0x0000000000000000000000000000000000000000', signers: [PRIYA], souls: {}, verified: {} });
  assert.deepEqual(await verifyCompany(COMPANY, { paymentModule: PM, mirror: MIRROR, call: notCompany.call }), { verified: false, reason: 'not-a-company' });
  assert.deepEqual(notCompany.calls, [`registryOf@${PM}`]);

  const unverified = chain({ registry: MIRROR, signers: [PRIYA], souls: { [PRIYA.toLowerCase()]: 1n }, verified: { 1: '0x0000000000000000000000000000000000000002' } });
  assert.deepEqual(await verifyCompany(COMPANY, { paymentModule: PM, mirror: MIRROR, call: unverified.call }), { verified: false, reason: 'no-verified-admin' });

  const passkeyOnly = chain({ registry: MIRROR, signers: [`0x${'11'.repeat(84)}`], souls: {}, verified: {} });
  assert.deepEqual(await verifyCompany(COMPANY, { paymentModule: PM, mirror: MIRROR, call: passkeyOnly.call }), { verified: false, reason: 'no-verified-admin' });
  assert.ok(!passkeyOnly.calls.some((c) => c.startsWith('soulOf')));
});
