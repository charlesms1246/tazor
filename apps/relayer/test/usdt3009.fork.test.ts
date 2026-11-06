// Live, read-only (eth_call) against the official USDT on Whitechain Sepolia: our EIP-712 domain and a locally
// signed EIP-3009 authorization are what the real token accepts. Skipped when the RPC is unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, createPublicClient, defineChain, domainSeparator, encodeFunctionData, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDT, USDT_DOMAIN, authorizationTypes, usdtAbi } from '../src/checkout/abi.ts';
import { liveChain } from '../src/checkout/chain.ts';
import { createX402, demoRequirements } from '../src/checkout/x402.ts';

const RPC = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const client = createPublicClient({ chain: defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }), transport: http(RPC) });
const reachable = await client.getChainId().then((id) => id === 1874, () => false);
const agent = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const DEAD = getAddress('0x000000000000000000000000000000000000dead');

const signed = async (value: bigint, nonce: Hex) => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const m = { from: agent.address, to: DEAD, value, validAfter: 0n, validBefore: now + 600n, nonce };
  return { m, sig: await agent.signTypedData({ domain: USDT_DOMAIN, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message: m }) };
};
const call = (m: Awaited<ReturnType<typeof signed>>['m'], sig: Hex) => client.call({ to: USDT, data: encodeFunctionData({ abi: usdtAbi, functionName: 'transferWithAuthorization', args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig] }) })
  .then(() => 'ok', (e: BaseError) => e.details ?? e.shortMessage);

test('USDT DOMAIN_SEPARATOR equals our {Tether USD, 1, 1874, USDT} domain', { skip: !reachable && 'Whitechain RPC unreachable' }, async () => {
  const onchain = await client.readContract({ address: USDT, abi: usdtAbi, functionName: 'DOMAIN_SEPARATOR' });
  assert.equal(onchain, domainSeparator({ domain: USDT_DOMAIN }));
});

test('a locally signed transferWithAuthorization verifies on the real token (eth_call); a tampered one is "invalid signature"', { skip: !reachable && 'Whitechain RPC unreachable' }, async () => {
  const nonce = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex;
  const zero = await signed(0n, nonce);
  assert.equal(await call(zero.m, zero.sig), 'ok', 'a zero-value authorization passes every check, the signature included');
  const flipped = (zero.sig.slice(0, -2) + (zero.sig.endsWith('1b') ? '1c' : '1b')) as Hex;
  assert.match(await call(zero.m, flipped), /invalid signature/);
  const one = await signed(1n, nonce);
  assert.match(await call(one.m, one.sig), /exceeds balance/, 'value 1: the signature passes, then the empty balance stops it');
});

test('the facilitator verify runs against the live token: a good signature reaches the balance check', { skip: !reachable && 'Whitechain RPC unreachable' }, async () => {
  const x = createX402({ chain: liveChain(client as never, { address: DEAD, send: async () => { throw new Error('read-only test'); } } as never) });
  const now = Math.floor(Date.now() / 1000);
  const req = demoRequirements('https://relayer.test/x402/demo/freight-quote', DEAD);
  const authorization = { from: agent.address, to: DEAD, value: '10000', validAfter: String(now - 60), validBefore: String(now + 300), nonce: `0x${'5b'.repeat(32)}` as Hex };
  const signature = await agent.signTypedData({ domain: USDT_DOMAIN, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message: { ...authorization, value: 10000n, validAfter: BigInt(now - 60), validBefore: BigInt(now + 300) } });
  const r = await x.verify({ x402Version: 1, paymentPayload: { x402Version: 1, scheme: 'exact', network: 'whitechain-sepolia', payload: { signature, authorization } }, paymentRequirements: req });
  assert.deepEqual(r, { isValid: false, invalidReason: 'insufficient_funds', payer: agent.address });
});
