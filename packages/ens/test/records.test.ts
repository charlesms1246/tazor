import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, namehash, toHex } from 'viem';
import { DEMO_RECORDS, ROLES_RECORD, WHITECHAIN_SEPOLIA_COIN_TYPE, alreadySet, coinTypeForChain, dnsEncode, isRetryable, recordCalls, registerMemberCall, resolverAbi, memberRegistryAbi } from '../src/records.ts';

test('ENSIP-11 coin types', () => {
  assert.equal(coinTypeForChain(1874), 0x80000752n);
  assert.equal(coinTypeForChain(1875), 0x80000753n);
  assert.equal(coinTypeForChain(1), 60n);
  assert.equal(WHITECHAIN_SEPOLIA_COIN_TYPE, 2147485522n);
  assert.throws(() => coinTypeForChain(-1));
  assert.throws(() => coinTypeForChain(0x80000000));
});

test('DNS wire encoding', () => {
  assert.equal(dnsEncode('acme.taz0r.eth'), toHex(Uint8Array.from([4, ...new TextEncoder().encode('acme'), 5, ...new TextEncoder().encode('taz0r'), 3, ...new TextEncoder().encode('eth'), 0])));
  assert.equal(dnsEncode(''), '0x00');
  assert.ok(namehash('acme.taz0r.eth').startsWith('0x'));
});

test('planned calls decode to the right resolver and registry arguments', () => {
  const acme = DEMO_RECORDS.find((c) => c.label === 'acme')!;
  const calls = recordCalls('acme.taz0r.eth', acme.texts, [[WHITECHAIN_SEPOLIA_COIN_TYPE, acme.whitechainAccount]]);
  assert.equal(calls.length, 7, 'name, description, url, tazor.role, tazor.roles, tazor.aliases, Whitechain address');
  const addr = decodeFunctionData({ abi: resolverAbi, data: calls[6].data });
  assert.equal(addr.functionName, 'setAddress');
  assert.deepEqual(addr.args, [dnsEncode('acme.taz0r.eth'), 0x80000752n, '0xb99a12652bee98429ae31ea0529a0b63f1073721']);
  const text = decodeFunctionData({ abi: resolverAbi, data: calls.find((c) => c.describe.includes('tazor.role'))!.data });
  assert.deepEqual(text.args, [dnsEncode('acme.taz0r.eth'), 'tazor.role', 'buyer']);
  const reg = decodeFunctionData({ abi: memberRegistryAbi, data: registerMemberCall('0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1', 'priya', acme.members[0].address, 'acme.taz0r.eth').data });
  assert.equal(reg.functionName, 'register');
  assert.equal(reg.args[0], 'priya');
  assert.equal(String(reg.args[1]).toLowerCase(), '0x00abed5bdddf794c415ee746d3e4de5332cc5450');
  assert.equal(acme.members.map((m) => m.label).join(','), 'priya,cfo,ravi,meera');
});

test('skip-if-set comparisons and retryable errors', () => {
  const calls = recordCalls('cfo.acme.taz0r.eth', { name: 'CFO, Finance' }, [[60n, '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967']]);
  assert.deepEqual(calls[0].expect, { kind: 'text', name: 'cfo.acme.taz0r.eth', key: 'name', value: 'CFO, Finance' });
  assert.equal(alreadySet(calls[0].expect!, 'CFO, Finance'), true);
  assert.equal(alreadySet(calls[0].expect!, 'CFO'), false);
  assert.equal(alreadySet(calls[0].expect!, null), false);
  assert.equal(alreadySet(calls[1].expect!, '0x20ba842dc15cbcf4e02d8ce77e07391a949bb967'), true);
  assert.equal(alreadySet(calls[1].expect!, '0x0000000000000000000000000000000000000001'), false);
  for (const m of ['HTTP 429 Too Many Requests', 'in-flight transaction limit reached for delegated accounts', 'gapped-nonce tx from delegated accounts', 'nonce too low']) assert.ok(isRetryable(m), m);
  assert.equal(isRetryable('execution reverted: EACUnauthorizedAccountRoles'), false);
});

test('tazor.roles: every demo company publishes the role bit map, identical to the web app\'s check', async () => {
  const { ROLE_BITS_RECORD } = await import('../../../apps/web/lib/role-bits.ts');
  assert.equal(ROLES_RECORD, ROLE_BITS_RECORD);
  for (const c of DEMO_RECORDS) {
    const calls = recordCalls(`${c.label}.taz0r.eth`, c.texts, [[WHITECHAIN_SEPOLIA_COIN_TYPE, c.whitechainAccount]]);
    const text = decodeFunctionData({ abi: resolverAbi, data: calls.find((x) => x.describe.includes('tazor.roles'))!.data });
    assert.deepEqual(text.args, [dnsEncode(`${c.label}.taz0r.eth`), 'tazor.roles', '{"APPROVER":64,"TAZOR_ADMIN":68,"AGENT":72}']);
  }
});
