import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineChain, encodeFunctionData, parseAbi } from 'viem';
import { createHandler } from '../src/app.ts';
import { createSender } from '../src/sender.ts';

const MM = '0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32';
const ID = '0x08d47f1cfdc3adfe04d41ce6135822149f4440ebf88fdc6b34612c9049c2e574';
const mandateBody = {
  mandate: {
    account: '0x18d15B034C645dbbFCb9c68238A14D059f632513', payee: '0xc1dce946D192e344251972470237F1471C93876c',
    capPerPeriod: '2000000', period: '2592000', expiry: '1801719053', nonce: '1',
  },
  approvers: ['0x00aBed5bDddf794c415eE746d3E4De5332cC5450'],
  signatures: ['0xabcdef'],
};
const abi = parseAbi([
  'function createMandate((address account,address payee,uint256 capPerPeriod,uint64 period,uint64 expiry,uint256 nonce) m, address[] approvers, bytes[] signatures)',
  'function pull(bytes32 mandateId, uint256 amount)',
]);

let rpc: Server;
let app: Server;
let bare: Server;
let base: string;
let bareBase: string;
const seen: string[] = [];
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };

before(async () => {
  rpc = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { id, method } = JSON.parse(raw);
    seen.push(method);
    const reply = method === 'eth_call'
      ? { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  const rpcUrl = await listen(rpc);
  const chain = defineChain({ id: 1874, name: 'mock', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const sender = createSender({ rpcUrl, chain, privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
  app = createServer(createHandler({ sender, mandateModule: MM }));
  base = await listen(app);
  bare = createServer(createHandler({ mandateModule: MM }));
  bareBase = await listen(bare);
});
after(() => { app.close(); bare.close(); rpc.close(); });

const post = (url: string, path: string, b: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

test('invalid /mandate and /pull bodies are 400 before any RPC call', async () => {
  seen.length = 0;
  const m = mandateBody.mandate;
  for (const bad of [
    { ...mandateBody, mandate: undefined }, { ...mandateBody, mandate: { ...m, payee: '0x12' } },
    { ...mandateBody, mandate: { ...m, period: String(2n ** 64n) } }, { ...mandateBody, mandate: { ...m, capPerPeriod: '1e6' } },
    { ...mandateBody, signatures: [] }, { ...mandateBody, approvers: [], signatures: [] },
  ]) assert.equal((await post(base, '/mandate', bad)).status, 400, JSON.stringify(bad));
  for (const bad of [{ mandateId: ID }, { mandateId: '0x1234', amount: '1' }, { mandateId: ID, amount: '0' }, { mandateId: ID, amount: '-5' }]) {
    assert.equal((await post(base, '/pull', bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(seen, []);
});

test('simulated reverts on /mandate and /pull are 422 and nothing is sent', async () => {
  seen.length = 0;
  for (const [path, b] of [['/mandate', mandateBody], ['/pull', { mandateId: ID, amount: '100000' }]] as const) {
    const r = await post(base, path, b);
    assert.equal(r.status, 422, path);
    assert.match((await r.json()).error, /simulation reverted/);
  }
  assert.ok(seen.includes('eth_call'));
  assert.ok(!seen.includes('eth_sendRawTransaction'));
});

test('createMandate and pull calldata match independent viem encodings', async () => {
  const m = await (await post(bareBase, '/mandate', mandateBody)).json();
  const mm = mandateBody.mandate;
  assert.equal(m.to, MM);
  assert.equal(m.data, encodeFunctionData({
    abi, functionName: 'createMandate',
    args: [{ account: mm.account as `0x${string}`, payee: mm.payee as `0x${string}`, capPerPeriod: 2000000n, period: 2592000n, expiry: 1801719053n, nonce: 1n },
      mandateBody.approvers as `0x${string}`[], mandateBody.signatures as `0x${string}`[]],
  }));
  const p = await (await post(bareBase, '/pull', { mandateId: ID, amount: '100000' })).json();
  assert.equal(p.data, encodeFunctionData({ abi, functionName: 'pull', args: [ID, 100000n] }));
});
