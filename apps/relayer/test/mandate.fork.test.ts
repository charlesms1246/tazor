import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createTestClient, defineChain, http, parseAbi, parseEther, toFunctionSelector, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHandler } from '../src/app.ts';
import { createSender } from '../src/sender.ts';

const FORK_URL = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const FORK_BLOCK = 12_347_100n;
const PORT = 8551;
const RPC = `http://127.0.0.1:${PORT}`;
const MM: Address = '0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32';
const ID: Hex = '0x08d47f1cfdc3adfe04d41ce6135822149f4440ebf88fdc6b34612c9049c2e574';
const USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const BLUEJAY: Address = '0xc1dce946D192e344251972470237F1471C93876c';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const abi = parseAbi(['function available(bytes32) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
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
  await createTestClient({ chain, mode: 'anvil', transport: http(RPC) }).setBalance({ address: privateKeyToAccount(KEY).address, value: parseEther('10') });
  server = createServer(createHandler({ sender: createSender({ rpcUrl: RPC, chain, privateKey: KEY }), mandateModule: MM }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`anvil fork of Whitechain Sepolia at block ${FORK_BLOCK}`);
});
after(() => { server?.close(); anvil?.kill(); });

const pull = (amount: bigint) =>
  fetch(`${base}/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandateId: ID, amount: amount.toString() }) });

test('pull over the remaining cap reverts in simulation (422, MandateOverCap)', async () => {
  const available = await pub.readContract({ address: MM, abi, functionName: 'available', args: [ID] });
  const r = await pull(available + 1n);
  assert.equal(r.status, 422);
  const { error } = await r.json();
  console.log(`available ${available}; over-cap 422: ${error}`);
  assert.ok(error.includes(`custom error ${toFunctionSelector('MandateOverCap(uint256,uint256)')}`), error);
});

test('pull within the cap is sent by the relayer and pays the payee', async () => {
  const before = await pub.readContract({ address: USDT, abi, functionName: 'balanceOf', args: [BLUEJAY] });
  const availableBefore = await pub.readContract({ address: MM, abi, functionName: 'available', args: [ID] });
  const r = await pull(100_000n);
  assert.equal(r.status, 200);
  const { txHash } = await r.json();
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  assert.equal(receipt.status, 'success');
  assert.equal(await pub.readContract({ address: USDT, abi, functionName: 'balanceOf', args: [BLUEJAY] }), before + 100_000n);
  assert.equal(await pub.readContract({ address: MM, abi, functionName: 'available', args: [ID] }), availableBefore - 100_000n);
  console.log(`pull 0.1 USDT gas ${receipt.gasUsed}`);
});
