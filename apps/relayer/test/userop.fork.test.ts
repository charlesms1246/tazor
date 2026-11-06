import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, encodeDeployData, encodeFunctionData,
  http, keccak256, parseAbi, parseEther, stringToHex, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHandler } from '../src/app.ts';
import { createSender } from '../src/sender.ts';
import { ENTRY_POINT_V08, packUserOp, parseUserOp } from '../src/userop.ts';

const FORK_URL = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const FORK_BLOCK = 12_351_283n;
const PORT = 8552;
const RPC = `http://127.0.0.1:${PORT}`;
const FACTORY: Address = '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e';
const MIRROR: Address = '0x9822650A99bD33F29E383345F570dAE1e4E00928';
const MIRROR_OWNER: Address = '0xce4389ACb79463062c362fACB8CB04513fA3D8D8';
const IS_VERIFIED: Address = '0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41';
const RELAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const relayer = privateKeyToAccount(RELAYER_KEY);
const wallet = createWalletClient({ chain, transport: http(RPC), account: relayer });
const abi = parseAbi([
  'function createAccount(bytes[] signers) returns (address)',
  'function predictAddress(bytes[] signers) view returns (address)',
  'function implementation() view returns (address)',
  'function registerSoul(address addr)',
  'function soulOf(address addr) view returns (uint256)',
  'function setAttribute(uint256 soulId, address attribute, bytes20 value)',
  'function deposit() payable',
  'function isSigner(bytes signer) view returns (bool)',
  'function addSigners(bytes[] signers)',
  'function execute(bytes32 mode, bytes executionData) payable',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) op) view returns (bytes32)',
]);

let anvil: ChildProcess;
let server: Server;
let base: string;
let paymaster: Address;

async function send(to: Address, data: Hex, value = 0n, from?: Address) {
  const hash = from
    ? await createWalletClient({ chain, transport: http(RPC) }).sendTransaction({ account: from, to, data, value, chain })
    : await wallet.sendTransaction({ to, data, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success');
  return r;
}

async function newApprover(name: string) {
  const owner = privateKeyToAccount(keccak256(stringToHex(`tazor userop fork ${name}`)));
  const signers = [owner.address as Hex];
  const account = await pub.readContract({ address: FACTORY, abi, functionName: 'predictAddress', args: [signers] });
  await send(FACTORY, encodeFunctionData({ abi, functionName: 'createAccount', args: [signers] }));
  return { owner, account };
}

async function verify(account: Address) {
  await send(MIRROR, encodeFunctionData({ abi, functionName: 'registerSoul', args: [account] }), 0n, MIRROR_OWNER);
  const soulId = await pub.readContract({ address: MIRROR, abi, functionName: 'soulOf', args: [account] });
  await send(MIRROR, encodeFunctionData({ abi, functionName: 'setAttribute', args: [soulId, IS_VERIFIED, '0x0000000000000000000000000000000000000001'] }), 0n, MIRROR_OWNER);
}

const rpcCall = async (method: string, params: unknown[]) =>
  (await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();

async function buildSignedOp(owner: ReturnType<typeof privateKeyToAccount>, account: Address, backup: Address) {
  const inner = encodeFunctionData({ abi, functionName: 'addSigners', args: [[backup]] });
  const batch = encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }], [[[account, 0n, inner]]]);
  const fees = await pub.estimateFeesPerGas();
  const draft: Record<string, string> = {
    sender: account,
    nonce: `0x${(await pub.readContract({ address: ENTRY_POINT_V08, abi, functionName: 'getNonce', args: [account, 0n] })).toString(16)}`,
    callData: encodeFunctionData({ abi, functionName: 'execute', args: ['0x0100000000000000000000000000000000000000000000000000000000000000', batch] }),
    maxFeePerGas: `0x${(fees.maxFeePerGas * 2n).toString(16)}`, maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
    signature: '0x',
  };
  const stub = await rpcCall('pm_getPaymasterStubData', [draft, ENTRY_POINT_V08, '0x752', {}]);
  if (stub.error) return { error: stub.error };
  const final = await rpcCall('pm_getPaymasterData', [{ ...draft, ...stub.result }, ENTRY_POINT_V08, '0x752', {}]);
  const op = { ...draft, ...final.result };
  delete (op as Record<string, unknown>).isFinal;
  const packed = packUserOp(parseUserOp(op, { requireSignature: false }));
  const hash = await pub.readContract({ address: ENTRY_POINT_V08, abi, functionName: 'getUserOpHash', args: [packed] });
  const sig = await owner.sign({ hash });
  op.signature = encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[owner.address], [sig]]);
  return { op };
}

before(async () => {
  anvil = spawn('anvil', ['--fork-url', FORK_URL, '--fork-block-number', String(FORK_BLOCK), '--port', String(PORT), '--silent'], { stdio: 'inherit' });
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); }
  }
  const tc = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
  await tc.setBalance({ address: relayer.address, value: parseEther('10') });
  await tc.impersonateAccount({ address: MIRROR_OWNER });
  await tc.setBalance({ address: MIRROR_OWNER, value: parseEther('1') });

  const artifact = JSON.parse(readFileSync(join(import.meta.dirname, '../../../contracts/out/SoulQuotaPaymaster.sol/SoulQuotaPaymaster.json'), 'utf8'));
  const implementation = await pub.readContract({ address: FACTORY, abi, functionName: 'implementation' });
  const deployHash = await wallet.sendTransaction({
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [ENTRY_POINT_V08, MIRROR, MIRROR, IS_VERIFIED, implementation, 2n, parseEther('0.05'), relayer.address] }),
  });
  paymaster = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
  await send(paymaster, encodeFunctionData({ abi, functionName: 'deposit' }), parseEther('1'));

  server = createServer(createHandler({ sender: createSender({ rpcUrl: RPC, chain, privateKey: RELAYER_KEY }), client: pub as never, paymaster, chainId: 1874 }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`anvil fork of Whitechain Sepolia at block ${FORK_BLOCK}, paymaster ${paymaster}`);
});
after(() => { server?.close(); anvil?.kill(); });

test('sponsored userOp end to end: ERC-7677 data, /userop bundles via handleOps, backup signer added, user pays 0', async () => {
  const { owner, account } = await newApprover('priya');
  await verify(account);
  const backup = '0x000000000000000000000000000000000000b0b0';
  const built = await buildSignedOp(owner, account, backup);
  assert.ok(built.op, JSON.stringify(built.error));
  assert.equal(built.op!.paymaster, paymaster);

  const res = await fetch(`${base}/userop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userOp: built.op }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const receipt = await pub.waitForTransactionReceipt({ hash: body.txHash });
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.to?.toLowerCase(), ENTRY_POINT_V08.toLowerCase());
  assert.equal(await pub.readContract({ address: account, abi, functionName: 'isSigner', args: [backup] }), true);
  assert.equal(await pub.getBalance({ address: account }), 0n);
  console.log(`handleOps tx gas ${receipt.gasUsed}`);
});

test('unverified approver: /rpc refuses before signing', async () => {
  const { owner, account } = await newApprover('ravi');
  const built = await buildSignedOp(owner, account, '0x000000000000000000000000000000000000b0b1');
  assert.equal(built.error?.code, -32000);
  assert.match(built.error?.message, /verified WB Soul/);
});

test('quota spent: /rpc refuses, and a forced /userop reverts in simulation (422)', async () => {
  const { owner, account } = await newApprover('cfo');
  await verify(account);
  let last: Record<string, string> | undefined;
  for (let i = 0; i < 2; i++) {
    const b = await buildSignedOp(owner, account, `0x00000000000000000000000000000000000c0${i}0${i}` as Address);
    last = b.op;
    const r = await fetch(`${base}/userop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userOp: b.op }) });
    const { txHash } = await r.json();
    await pub.waitForTransactionReceipt({ hash: txHash });
  }
  const third = await buildSignedOp(owner, account, '0x00000000000000000000000000000000000c0303');
  assert.match(third.error?.message ?? '', /quota/);
  const nonce = await pub.readContract({ address: ENTRY_POINT_V08, abi, functionName: 'getNonce', args: [account, 0n] });
  const forced = { ...last!, nonce: `0x${nonce.toString(16)}` };
  const r = await fetch(`${base}/userop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userOp: forced }) });
  assert.equal(r.status, 422);
  console.log(`forced over-quota /userop: ${(await r.json()).error.slice(0, 120)}`);
});

