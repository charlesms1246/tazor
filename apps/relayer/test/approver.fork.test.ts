import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { concat, createPublicClient, createTestClient, defineChain, http, parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHandler } from '../src/app.ts';
import { createApproverDeployer } from '../src/approver.ts';
import { createSender } from '../src/sender.ts';

const FORK_URL = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const FORK_BLOCK = 12_346_200n;
const PORT = 8549;
const RPC = `http://127.0.0.1:${PORT}`;
const FACTORY: Address = '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const X = '0x5c324e72c96949335cb63308f0749970b0ae7d88c3e2401b462197f866a92657';
const Y = '0xa760695d6d1b2abfeaca93df16a38ca558b49014a4e6f2711c067ef7570ef126';
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

let anvil: ChildProcess;
let server: Server;
let base: string;
const pub = createPublicClient({ chain, transport: http(RPC) });

before(async () => {
  anvil = spawn('anvil', ['--fork-url', FORK_URL, '--fork-block-number', String(FORK_BLOCK), '--port', String(PORT), '--silent'], { stdio: 'inherit' });
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); }
  }
  const relayer = privateKeyToAccount(KEY).address;
  await createTestClient({ chain, mode: 'anvil', transport: http(RPC) }).setBalance({ address: relayer, value: parseEther('10') });
  const handler = createHandler({ sender: createSender({ rpcUrl: RPC, chain, privateKey: KEY }), approvers: createApproverDeployer(pub, FACTORY) });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`anvil fork of Whitechain Sepolia at block ${FORK_BLOCK}, relayer ${relayer}`);
});
after(() => { server?.close(); anvil?.kill(); });

const post = (signer: string) =>
  fetch(`${base}/approver`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signer }) });

async function deployTwice(signer: string) {
  const r1 = await post(signer);
  assert.equal(r1.status, 200);
  const first = await r1.json();
  assert.match(first.txHash, /^0x[0-9a-f]{64}$/);
  const receipt = await pub.waitForTransactionReceipt({ hash: first.txHash });
  assert.equal(receipt.status, 'success');
  assert.notEqual((await pub.getCode({ address: first.account })) ?? '0x', '0x');
  const second = await (await post(signer)).json();
  assert.deepEqual(second, { account: first.account, txHash: null });
  return { account: first.account as Address, gas: receipt.gasUsed };
}

test('passkey approver deploys once, then the endpoint is idempotent', async () => {
  const verifier = await pub.readContract({ address: FACTORY, abi: [{ type: 'function', name: 'webAuthnVerifier', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }], functionName: 'webAuthnVerifier' });
  const { account, gas } = await deployTwice(concat([verifier, X, Y]));
  console.log(`passkey approver ${account} createAccount gas ${gas}`);
});

test('EOA backup-only approver deploys once, then idempotent', async () => {
  const { account, gas } = await deployTwice('0x000000000000000000000000000000000000b0b0');
  console.log(`EOA approver ${account} createAccount gas ${gas}`);
});

test('a passkey id for a foreign verifier is rejected with 400 before any send', async () => {
  const r = await post(concat(['0x0000000000000000000000000000000000000bad', X, Y]));
  assert.equal(r.status, 400);
});
