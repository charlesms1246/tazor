import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import {
  concat, createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData,
  http, keccak256, parseAbi, parseEther, serializeErc6492Signature, toHex, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHandler } from '../src/app.ts';
import { createApproverDeployer } from '../src/approver.ts';
import { createSender } from '../src/sender.ts';

const FORK_URL = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const FORK_BLOCK = 12_347_000n; // acme v1 is configured from block 12,346,4xx
const PORT = 8553;
const RPC = `http://127.0.0.1:${PORT}`;
const FACTORY: Address = '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e';
const PM: Address = '0xe19ddf1fd417B146137A5dE6eb56c4589431540A';
const ROLE_CACHE: Address = '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe';
const MIRROR: Address = '0x9822650A99bD33F29E383345F570dAE1e4E00928';
const OWNER: Address = '0xce4389ACb79463062c362fACB8CB04513fA3D8D8';
const USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const IS_VERIFIED: Address = '0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41';
const ACME: Address = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const BLUEJAY: Address = '0xc1dce946D192e344251972470237F1471C93876c';
const RELAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/webauthn.json', import.meta.url), 'utf8'));
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

const abi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function invoiceDigest(InvoiceAuth auth) view returns (bytes32)',
  'function runDigest(InvoiceAuth[] auths) view returns (bytes32)',
  'function isPaid(address account, uint256 nonce) view returns (bool)',
  'function registryOf(address account) view returns (address)',
  'function webAuthnVerifier() view returns (address)',
  'function predictAddress(bytes[] signers) view returns (address)',
  'function createAccount(bytes[] signers) returns (address)',
  'function registerSoul(address addr)',
  'function soulOf(address addr) view returns (uint256)',
  'function setAttribute(uint256 soulId, address attribute, bytes20 value)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

let anvil: ChildProcess;
let server: Server;
let base: string;
const pub = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
let registry: Address;
let verifier: Address;

async function asOwner(to: Address, data: Hex) {
  const w = createWalletClient({ chain, transport: http(RPC), account: OWNER });
  const hash = await w.sendTransaction({ to, data, account: OWNER, chain });
  assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
}

/** A counterfactual ApproverAccount(signers [fixture passkey, backup EOA]): verified soul + cached APPROVER role. */
async function newApprover(seed: string) {
  const backupKey = keccak256(toHex(seed));
  const backup = privateKeyToAccount(backupKey);
  const signers: Hex[] = [concat([verifier, fixture.x as Hex, fixture.y as Hex]), backup.address];
  const account = await pub.readContract({ address: FACTORY, abi, functionName: 'predictAddress', args: [signers] });
  assert.equal((await pub.getCode({ address: account })) ?? '0x', '0x', 'not deployed yet');
  await asOwner(MIRROR, encodeFunctionData({ abi, functionName: 'registerSoul', args: [account] }));
  const soul = await pub.readContract({ address: MIRROR, abi, functionName: 'soulOf', args: [account] });
  await asOwner(MIRROR, encodeFunctionData({ abi, functionName: 'setAttribute', args: [soul, IS_VERIFIED, '0x0000000000000000000000000000000000000001'] }));
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [account, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [registry, 0n]))]));
  await testClient.setStorageAt({ address: ROLE_CACHE, index: slot, value: toHex(1n << 64n, { size: 32 }) });
  await testClient.setStorageAt({ address: ROLE_CACHE, index: toHex(BigInt(slot) + 1n, { size: 32 }), value: toHex(1n, { size: 32 }) });
  const sign = async (digest: Hex) => {
    const sig = await backup.sign({ hash: digest });
    const inner = encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[backup.address], [sig]]);
    return serializeErc6492Signature({ address: FACTORY, data: encodeFunctionData({ abi, functionName: 'createAccount', args: [signers] }), signature: inner });
  };
  return { account, sign };
}

const auth = (nonce: bigint, amount = 100_000n) => ({
  invoiceHash: keccak256(toHex(`erc6492 fork invoice ${nonce}`)), account: ACME, payee: BLUEJAY, amount, expiry: 4_000_000_000n, nonce,
});
const json = (a: ReturnType<typeof auth>) => ({ ...a, amount: a.amount.toString(), expiry: a.expiry.toString(), nonce: a.nonce.toString() });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  anvil = spawn('anvil', ['--fork-url', FORK_URL, '--fork-block-number', String(FORK_BLOCK), '--port', String(PORT), '--silent'], { stdio: 'inherit' });
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); }
  }
  await testClient.setBalance({ address: privateKeyToAccount(RELAYER_KEY).address, value: parseEther('10') });
  await testClient.impersonateAccount({ address: OWNER });
  await testClient.setBalance({ address: OWNER, value: parseEther('10') });
  await asOwner(USDT, encodeFunctionData({ abi, functionName: 'transfer', args: [ACME, 2_000_000n] }));
  registry = await pub.readContract({ address: PM, abi, functionName: 'registryOf', args: [ACME] });
  verifier = await pub.readContract({ address: FACTORY, abi, functionName: 'webAuthnVerifier' });
  const handler = createHandler({
    sender: createSender({ rpcUrl: RPC, chain, privateKey: RELAYER_KEY }), paymentModule: PM,
    approvers: createApproverDeployer(pub, FACTORY), client: pub as never,
  });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`anvil fork of Whitechain Sepolia at block ${FORK_BLOCK}; acme registry ${registry}`);
});
after(() => { server?.close(); anvil?.kill(); });

test('ERC-6492: an undeployed approver\'s wrapped approval -> relayer deploys it -> payOne succeeds', async () => {
  const a = await newApprover('6492-pay');
  const x = auth(9_000_001n);
  const digest = await pub.readContract({ address: PM, abi, functionName: 'invoiceDigest', args: [x] });
  const r = await post('/pay', { account: ACME, auth: json(x), approvers: [a.account], signatures: [await a.sign(digest)] });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.deployTxs.length, 1);
  const deploy = await pub.waitForTransactionReceipt({ hash: body.deployTxs[0] });
  assert.equal(deploy.status, 'success');
  assert.notEqual((await pub.getCode({ address: a.account })) ?? '0x', '0x', 'approver deployed by the relayer');
  const pay = await pub.waitForTransactionReceipt({ hash: body.txHash });
  assert.equal(pay.status, 'success');
  assert.equal(await pub.readContract({ address: PM, abi, functionName: 'isPaid', args: [ACME, x.nonce] }), true);
  console.log(`6492 deploy gas ${deploy.gasUsed}, payOne gas ${pay.gasUsed}`);

  // once deployed, the same wrapped form still works and no second deploy is sent
  const y = auth(9_000_002n);
  const d2 = await pub.readContract({ address: PM, abi, functionName: 'invoiceDigest', args: [y] });
  const b2 = await (await post('/pay', { account: ACME, auth: json(y), approvers: [a.account], signatures: [await a.sign(d2)] })).json();
  assert.deepEqual(b2.deployTxs, []);
  assert.equal((await pub.waitForTransactionReceipt({ hash: b2.txHash })).status, 'success');
});

test('ERC-6492: a wrapped approval that does not verify is refused with 400 and nothing is deployed', async () => {
  const a = await newApprover('6492-bad');
  const x = auth(9_000_003n);
  const wrongDigest = keccak256(toHex('not this invoice'));
  const r = await post('/pay', { account: ACME, auth: json(x), approvers: [a.account], signatures: [await a.sign(wrongDigest)] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /does not verify/);
  assert.equal((await pub.getCode({ address: a.account })) ?? '0x', '0x');
});

test('ERC-6492: an account without PaymentModule config is refused before any deploy', async () => {
  const a = await newApprover('6492-noconfig');
  const NOBODY: Address = '0x000000000000000000000000000000000000c0ff';
  const x = { ...auth(9_000_004n), account: NOBODY };
  const r = await post('/pay', { account: NOBODY, auth: json(x), approvers: [a.account], signatures: [await a.sign(keccak256(toHex('x')))] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no PaymentModule configuration/);
  assert.equal((await pub.getCode({ address: a.account })) ?? '0x', '0x');
});

test('ERC-6492 via /payrun: deploys the approver and pays a 2-invoice run on v1', async () => {
  const a = await newApprover('6492-run');
  const run = [auth(9_000_010n), auth(9_000_011n)];
  const digest = await pub.readContract({ address: PM, abi, functionName: 'runDigest', args: [run] });
  const r = await post('/payrun', { account: ACME, auths: run.map(json), approvers: [a.account], signatures: [await a.sign(digest)] });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.paymentModule.toLowerCase(), PM.toLowerCase(), 'v1 account -> v1 module');
  assert.equal(body.deployTxs.length, 1);
  assert.equal((await pub.waitForTransactionReceipt({ hash: body.txHash })).status, 'success');
  for (const x of run) assert.equal(await pub.readContract({ address: PM, abi, functionName: 'isPaid', args: [ACME, x.nonce] }), true);
});
