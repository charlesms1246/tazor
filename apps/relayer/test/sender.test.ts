import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, defineChain, http } from 'viem';
import { createSender } from '../src/sender.ts';

const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const chain = defineChain({ id: 1874, name: 'local', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
let anvil: ChildProcess;

before(async () => {
  anvil = spawn('anvil', ['--chain-id', '1874', '--port', String(PORT), '--block-time', '1', '--silent'], { stdio: 'inherit' });
  const c = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; ; i++) {
    try { await c.getChainId(); break; } catch { if (i > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => anvil?.kill());

test('concurrent sends are signed locally and serialised with sequential nonces', async () => {
  const sender = createSender({ rpcUrl: RPC, chain, privateKey: ANVIL_KEY_0, to: '0x0000000000000000000000000000000000007000' });
  const hashes = await Promise.all([sender.send('0x01'), sender.send('0x02'), sender.send('0x03')]);
  const c = createPublicClient({ chain, transport: http(RPC) });
  const receipts = await Promise.all(hashes.map((hash) => c.waitForTransactionReceipt({ hash })));
  const txs = await Promise.all(hashes.map((hash) => c.getTransaction({ hash })));
  assert.deepEqual(txs.map((t) => t.nonce), [0, 1, 2]);
  assert.ok(receipts.every((r) => r.status === 'success'));
  assert.ok(receipts[0].blockNumber < receipts[1].blockNumber && receipts[1].blockNumber < receipts[2].blockNumber, 'one in flight at a time');
  assert.deepEqual(txs.map((t) => t.input), ['0x01', '0x02', '0x03']);
});
