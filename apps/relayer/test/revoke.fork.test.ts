import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createTestClient, defineChain, http, keccak256, parseAbi, parseEther, stringToHex, toFunctionSelector, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHandler } from '../src/app.ts';
import { createSender } from '../src/sender.ts';

const FORK_URL = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const FORK_BLOCK = 12_346_600n;
const PORT = 8550;
const RPC = `http://127.0.0.1:${PORT}`;
const RL: Address = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e';
const ACME: Address = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const PRIYA: Address = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const RELAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const outsider = privateKeyToAccount(keccak256(stringToHex('tazor revoke fork test outsider')));
const abi = parseAbi([
  'function revokeDigest(address account, address target, uint256 deadline) view returns (bytes32)',
  'function isRevoked(address account, address target) view returns (bool)',
]);
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });

let anvil: ChildProcess;
let server: Server;
let base: string;

before(async () => {
  anvil = spawn('anvil', ['--fork-url', FORK_URL, '--fork-block-number', String(FORK_BLOCK), '--port', String(PORT), '--silent'], { stdio: 'inherit' });
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); }
  }
  const relayer = privateKeyToAccount(RELAYER_KEY).address;
  await createTestClient({ chain, mode: 'anvil', transport: http(RPC) }).setBalance({ address: relayer, value: parseEther('10') });
  server = createServer(createHandler({ sender: createSender({ rpcUrl: RPC, chain, privateKey: RELAYER_KEY }), revocationList: RL }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`anvil fork of Whitechain Sepolia at block ${FORK_BLOCK}, outsider admin ${outsider.address}`);
});
after(() => { server?.close(); anvil?.kill(); });

test('an ECDSA revoke signed by a non-admin EOA reverts in simulation and returns 422', async () => {
  const deadline = BigInt((await pub.getBlock()).timestamp) + 600n;
  const digest = await pub.readContract({ address: RL, abi, functionName: 'revokeDigest', args: [ACME, PRIYA, deadline] });
  const sig = await outsider.sign({ hash: digest });
  const relayer = privateKeyToAccount(RELAYER_KEY).address;
  const nonceBefore = await pub.getTransactionCount({ address: relayer });

  const res = await fetch(`${base}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ACME, target: PRIYA, admin: outsider.address, deadline: deadline.toString(), sig }),
  });
  assert.equal(res.status, 422);
  const { error } = await res.json();
  console.log(`422: ${error}`);
  assert.match(error, /simulation reverted/);
  assert.ok(error.includes(`custom error ${toFunctionSelector('RevocationInvalidAdmin(address)')}`), 'RevocationInvalidAdmin');
  assert.ok(error.toLowerCase().includes(outsider.address.slice(2).toLowerCase()), 'reverts for the outsider admin');
  assert.equal(await pub.getTransactionCount({ address: relayer }), nonceBefore, 'nothing was sent');
  assert.equal(await pub.readContract({ address: RL, abi, functionName: 'isRevoked', args: [ACME, PRIYA] }), false);
});
