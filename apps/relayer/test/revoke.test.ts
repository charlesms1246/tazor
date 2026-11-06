import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineChain, encodeErrorResult, encodeFunctionData, parseAbi } from 'viem';
import { createHandler } from '../src/app.ts';
import { createSender } from '../src/sender.ts';

const RL = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e';
const body = {
  account: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  target: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450',
  admin: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967',
  deadline: '2000000000',
  sig: '0xabcdef',
};
const errAbi = parseAbi(['error RevocationInvalidAdmin(address admin)']);
const revertData = encodeErrorResult({ abi: errAbi, errorName: 'RevocationInvalidAdmin', args: [body.admin as `0x${string}`] });

let rpc: Server;
let app: Server;
let base: string;
const seen: string[] = [];

const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };

before(async () => {
  rpc = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { id, method } = JSON.parse(raw);
    seen.push(method);
    const reply = method === 'eth_call'
      ? { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: revertData } }
      : method === 'eth_chainId' ? { jsonrpc: '2.0', id, result: '0x752' }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  const rpcUrl = await listen(rpc);
  const chain = defineChain({ id: 1874, name: 'mock', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const sender = createSender({ rpcUrl, chain, privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
  app = createServer(createHandler({ sender, revocationList: RL }));
  base = await listen(app);
});
after(() => { app.close(); rpc.close(); });

const post = (b: unknown) => fetch(`${base}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

test('invalid /revoke bodies are rejected with 400 before any RPC call', async () => {
  seen.length = 0;
  for (const bad of [
    { ...body, account: '0x1234' }, { ...body, target: undefined }, { ...body, admin: 'nope' },
    { ...body, deadline: '-1' }, { ...body, deadline: '1.5' }, { ...body, sig: '0x' }, { ...body, sig: 'abc' },
  ]) {
    const r = await post(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(seen, []);
});

test('a simulated revert is passed through as 422 and nothing is sent', async () => {
  seen.length = 0;
  const r = await post(body);
  assert.equal(r.status, 422);
  const { error } = await r.json();
  assert.match(error, /simulation reverted/);
  assert.ok(seen.includes('eth_call'));
  assert.ok(!seen.includes('eth_sendRawTransaction'));
});

test('revoke calldata matches an independent viem encoding', async () => {
  const unconfigured = createServer(createHandler({ revocationList: RL }));
  const url = await listen(unconfigured);
  const r = await fetch(`${url}/revoke`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 503);
  const { to, data } = await r.json();
  unconfigured.close();
  const expected = encodeFunctionData({
    abi: parseAbi(['function revoke(address,address,address,uint256,bytes)']),
    functionName: 'revoke',
    args: [body.account as `0x${string}`, body.target as `0x${string}`, body.admin as `0x${string}`, 2000000000n, '0xabcdef'],
  });
  assert.equal(to, RL);
  assert.equal(data, expected);
});
