import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, defineChain } from 'viem';
import { createHandler } from '../src/app.ts';
import { createSender } from '../src/sender.ts';
import { ENTRY_POINT_V08, SUGGESTED_GAS, entryPointAbi, encodeHandleOps, packUserOp, parseUserOp } from '../src/userop.ts';

const PM = '0x0000000000000000000000000000000000007777';
const op = {
  sender: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', nonce: '0x3', callData: '0xb61d27f6',
  callGasLimit: '0x30d40', verificationGasLimit: '0x927c0', preVerificationGas: '0x249f0',
  maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00',
  paymaster: PM, paymasterVerificationGasLimit: '0x30d40', paymasterPostOpGasLimit: '0x186a0', paymasterData: '0xabcd',
  signature: '0x1234',
};

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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(method === 'eth_call'
      ? { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } }));
  });
  const rpcUrl = await listen(rpc);
  const chain = defineChain({ id: 1874, name: 'mock', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  app = createServer(createHandler({ sender: createSender({ rpcUrl, chain, privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' }), paymaster: PM, chainId: 1874 }));
  base = await listen(app);
  bare = createServer(createHandler({ chainId: 1874 }));
  bareBase = await listen(bare);
});
after(() => { app.close(); bare.close(); rpc.close(); });

const post = (url: string, path: string, b: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const call = async (url: string, method: string, params: unknown) =>
  (await post(url, '/rpc', { jsonrpc: '2.0', id: 9, method, params })).json();

test('v0.8 packing and handleOps encoding round trip', () => {
  const parsed = parseUserOp(op, { requireSignature: true });
  const p = packUserOp(parsed);
  assert.equal(p.accountGasLimits, '0x000000000000000000000000000927c000000000000000000000000000030d40');
  assert.equal(p.paymasterAndData, '0x000000000000000000000000000000000000777700000000000000000000000000030d40000000000000000000000000000186a0abcd');
  const d = decodeFunctionData({ abi: entryPointAbi, data: encodeHandleOps(parsed, '0x000000000000000000000000000000000000bEEF') });
  assert.equal(d.functionName, 'handleOps');
  assert.equal(d.args[0][0].sender, op.sender);
  assert.equal(d.args[1], '0x000000000000000000000000000000000000bEEF');
});

test('pm_getPaymasterStubData / pm_getPaymasterData return v0.8 fields and suggested gas', async () => {
  for (const method of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
    const r = await call(base, method, [{ ...op, verificationGasLimit: '0x1' }, ENTRY_POINT_V08, '0x752', {}]);
    assert.equal(r.id, 9);
    assert.equal(r.result.paymaster, PM);
    assert.equal(r.result.paymasterData, '0x');
    assert.equal(BigInt(r.result.verificationGasLimit), SUGGESTED_GAS.verificationGasLimit, 'raised to the suggested floor');
    assert.equal(BigInt(r.result.paymasterVerificationGasLimit), SUGGESTED_GAS.paymasterVerificationGasLimit);
  }
});

test('/rpc errors: wrong entryPoint, wrong chain, unknown method, bad op, no paymaster', async () => {
  const cases: [string, unknown, number, Server | string][] = [
    ['pm_getPaymasterData', [op, '0x0000000071727De22E5E9d8BAf0edAc6f37da032', '0x752', {}], -32602, base],
    ['pm_getPaymasterData', [op, ENTRY_POINT_V08, '0x1', {}], -32602, base],
    ['eth_sendUserOperation', [op, ENTRY_POINT_V08], -32601, base],
    ['pm_getPaymasterData', [{ ...op, sender: '0x12' }, ENTRY_POINT_V08, '0x752', {}], -32602, base],
    ['pm_getPaymasterData', [op, ENTRY_POINT_V08, '0x752', {}], -32000, bareBase],
  ];
  for (const [method, params, code, url] of cases) {
    const r = await call(url as string, method, params);
    assert.equal(r.error?.code, code, `${method} ${JSON.stringify(params).slice(0, 60)}`);
  }
});

test('/userop: invalid ops are 400 with no RPC calls; a simulated revert is 422; no key is 503', async () => {
  seen.length = 0;
  for (const bad of [{}, { userOp: { ...op, signature: '0x' } }, { userOp: { ...op, nonce: '7' } }, { userOp: { ...op, callGasLimit: `0x${'f'.repeat(33)}` } }]) {
    assert.equal((await post(base, '/userop', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(seen.length, 0);
  const r = await post(base, '/userop', { userOp: op });
  assert.equal(r.status, 422);
  assert.ok(!seen.includes('eth_sendRawTransaction'));
  assert.equal((await post(bareBase, '/userop', { userOp: op })).status, 503);
});
