import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem';
import { createHandler } from '../src/app.ts';
import { PAYMENT_MODULE_V2 } from '../src/payrun.ts';
import { REVOCATION_LIST_V2 } from '../src/revoke-list.ts';
import { revocationListAbi } from '../src/revoke.ts';

const abi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function payRun(address account, InvoiceAuth[] auths, address[] approvers, bytes[] signatures)',
  'function payOne(address account, InvoiceAuth auth, address[] approvers, bytes[] signatures)',
  'function registryOf(address account) view returns (address)',
]);
const V1: Address = '0x0000000000000000000000000000000000007000';
const V1_LIST: Address = '0x0000000000000000000000000000000000007005';
const V2_ACCOUNT: Address = '0x00000000000000000000000000000000000000b2';
const V1_ACCOUNT: Address = '0x00000000000000000000000000000000000000b1';
const auth = (account: Address, nonce: number) => ({
  invoiceHash: `0x${'11'.repeat(32)}`, account, payee: '0x0000000000000000000000000000000000000003', amount: '1000000', expiry: '2000000000', nonce: String(nonce),
});
const run = (account: Address) => ({ account, auths: [auth(account, 1), auth(account, 2)], approvers: ['0x00000000000000000000000000000000000a11ce'], signatures: ['0xaa01'] });

let rpc: Server, app: Server, base: string;
const sent: { to: Address; data: Hex }[] = [];
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };

before(async () => {
  rpc = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { id, method, params } = JSON.parse(raw);
    const ok = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (method === 'eth_chainId') return ok('0x752');
    if (method === 'eth_call') {
      // registryOf: each module reports its own configured account
      const to = params[0].to.toLowerCase();
      const { args } = decodeFunctionData({ abi, data: params[0].data });
      const who = (args![0] as string).toLowerCase();
      const mine = to === PAYMENT_MODULE_V2.toLowerCase() ? V2_ACCOUNT : to === V1.toLowerCase() ? V1_ACCOUNT : null;
      const reg = who === mine ? '0x00000000000000000000000000000000000000e5' : '0x0000000000000000000000000000000000000000';
      return ok(encodeAbiParameters([{ type: 'address' }], [reg as Address]));
    }
    res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } }));
  });
  const client = createPublicClient({ transport: http(await listen(rpc)) });
  const sender = { address: '0x000000000000000000000000000000000000beef' as Address, send: async (to: Address, data: Hex) => { sent.push({ to, data }); return `0x${'ab'.repeat(32)}` as Hex; } };
  app = createServer(createHandler({
    sender: sender as never, paymentModule: V1, revocationList: V1_LIST, client: client as never,
    approvers: { factory: '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e' } as never,
  }));
  base = await listen(app);
});
after(() => { app.close(); rpc.close(); });
const post = (path: string, b: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

const expectedRun = (r: ReturnType<typeof run>) => encodeFunctionData({
  abi, functionName: 'payRun',
  args: [r.account, r.auths.map((a) => ({ ...a, invoiceHash: a.invoiceHash as Hex, payee: a.payee as Address, amount: BigInt(a.amount), expiry: BigInt(a.expiry), nonce: BigInt(a.nonce) })), r.approvers as Address[], r.signatures as Hex[]],
});

test('/payrun for a v2 account sends payRun to PaymentModuleV2 with the exact calldata', async () => {
  sent.length = 0;
  const body = run(V2_ACCOUNT);
  const r = await post('/payrun', body);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.paymentModule.toLowerCase(), PAYMENT_MODULE_V2.toLowerCase());
  assert.deepEqual(j.deployTxs, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.toLowerCase(), PAYMENT_MODULE_V2.toLowerCase());
  assert.equal(sent[0].data, expectedRun(body));
});

test('/payrun for a v1 account sends to the v1 PaymentModule', async () => {
  sent.length = 0;
  const body = run(V1_ACCOUNT);
  const j = await (await post('/payrun', body)).json();
  assert.equal(j.paymentModule.toLowerCase(), V1.toLowerCase());
  assert.equal(sent[0].to.toLowerCase(), V1.toLowerCase());
  assert.equal(sent[0].data, expectedRun(body));
});

test('/payrun input validation (400 before any send)', async () => {
  sent.length = 0;
  const bad = [
    { ...run(V1_ACCOUNT), auths: [] },
    { ...run(V1_ACCOUNT), auths: [auth(V1_ACCOUNT, 1), auth(V2_ACCOUNT, 2)] },
    { ...run(V1_ACCOUNT), signatures: [] },
    { ...run(V1_ACCOUNT), auths: Array.from({ length: 51 }, (_, i) => auth(V1_ACCOUNT, i)) },
    { ...run(V1_ACCOUNT), auths: [{ ...auth(V1_ACCOUNT, 1), expiry: String(2n ** 64n) }] },
  ];
  for (const b of bad) assert.equal((await post('/payrun', b)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal(sent.length, 0);
});

test('/pay with plain approvals is unchanged (no deploys, payOne to v1)', async () => {
  sent.length = 0;
  const a = auth(V1_ACCOUNT, 3);
  const j = await (await post('/pay', { account: V1_ACCOUNT, auth: a, approvers: ['0x00000000000000000000000000000000000a11ce'], signatures: ['0xaa01'] })).json();
  assert.deepEqual(j.deployTxs, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, V1);
  assert.equal(decodeFunctionData({ abi, data: sent[0].data }).functionName, 'payOne');
});

test('/pay for a v2 account sends payOne to PaymentModuleV2 and names it in the response', async () => {
  sent.length = 0;
  const a = auth(V2_ACCOUNT, 4);
  const body = { account: V2_ACCOUNT, auth: a, approvers: ['0x00000000000000000000000000000000000a11ce'], signatures: ['0xaa01'] };
  const r = await post('/pay', body);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.paymentModule.toLowerCase(), PAYMENT_MODULE_V2.toLowerCase());
  assert.deepEqual(j.deployTxs, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.toLowerCase(), PAYMENT_MODULE_V2.toLowerCase());
  const { functionName, args } = decodeFunctionData({ abi, data: sent[0].data });
  assert.equal(functionName, 'payOne');
  assert.equal((args![0] as string).toLowerCase(), V2_ACCOUNT);
  // /pay/calldata is unchanged: it still names the v1 module
  assert.equal((await (await post('/pay/calldata', body)).json()).to, V1);
});

test('/pay for an account configured on neither module is 400 before any send', async () => {
  sent.length = 0;
  const other = '0x00000000000000000000000000000000000000c0' as Address;
  const r = await post('/pay', { account: other, auth: auth(other, 5), approvers: ['0x00000000000000000000000000000000000a11ce'], signatures: ['0xaa01'] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no PaymentModule configuration/);
  assert.equal(sent.length, 0);
});

test('/payrun for an account configured on neither module is 400 before any send', async () => {
  sent.length = 0;
  const r = await post('/payrun', run('0x00000000000000000000000000000000000000c0'));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no PaymentModule configuration/);
  assert.equal(sent.length, 0);
});

test('/revoke list param: v1 default, v2 accepted, anything else 400', async () => {
  const r = { account: V1_ACCOUNT, target: '0x00000000000000000000000000000000000a11ce', admin: '0x00000000000000000000000000000000000a11ce', deadline: '2000000000', sig: '0xabcdef' };
  sent.length = 0;
  assert.equal((await post('/revoke', r)).status, 200);
  assert.equal(sent[0].to, V1_LIST);
  assert.equal((await post('/revoke', { ...r, list: REVOCATION_LIST_V2 })).status, 200);
  assert.equal(sent[1].to.toLowerCase(), REVOCATION_LIST_V2.toLowerCase());
  assert.equal(decodeFunctionData({ abi: revocationListAbi, data: sent[1].data }).functionName, 'revoke');
  const bad = await post('/revoke', { ...r, list: '0x000000000000000000000000000000000000dead' });
  assert.equal(bad.status, 400);
  assert.equal(sent.length, 2);
});
