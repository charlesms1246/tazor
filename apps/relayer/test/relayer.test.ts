import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeFunctionData, parseAbi } from 'viem';
import { createHandler } from '../src/app.ts';

const abi = parseAbi([
  'function payOne(address account, (bytes32 invoiceHash, address account, address payee, uint256 amount, uint64 expiry, uint256 nonce) auth, address[] approvers, bytes[] signatures)',
]);

const ACCOUNT = '0x00000000000000000000000000000000000000ac';
const body = {
  account: ACCOUNT,
  auth: {
    invoiceHash: '0xc85cca45cd5c38307310a6605ded415efbb52cb66abe16037c923ad1ae4d059d',
    account: ACCOUNT,
    payee: '0x0000000000000000000000000000000000000003',
    amount: '1250500000',
    expiry: '2000000000',
    nonce: '7',
  },
  approvers: ['0x00000000000000000000000000000000000a11ce', '0x0000000000000000000000000000000000000b0b'],
  signatures: ['0xaa01', '0xbb02bb02'],
};

let server: Server;
let base: string;
before(async () => {
  server = createServer(createHandler({ paymentModule: '0x0000000000000000000000000000000000007000' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, b: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

test('calldata equals viem encodeFunctionData for a fixed vector', async () => {
  const res = await post('/pay/calldata', body);
  assert.equal(res.status, 200);
  const { to, data } = await res.json();
  const expected = encodeFunctionData({
    abi, functionName: 'payOne',
    args: [ACCOUNT, { ...body.auth, invoiceHash: body.auth.invoiceHash as `0x${string}`, account: ACCOUNT, payee: body.auth.payee as `0x${string}`, amount: 1250500000n, expiry: 2000000000n, nonce: 7n }, body.approvers as `0x${string}`[], body.signatures as `0x${string}`[]],
  });
  assert.equal(data, expected);
  assert.equal(to, '0x0000000000000000000000000000000000007000');
  console.log('payOne calldata', data.slice(0, 10), `${(data.length - 2) / 2} bytes`);
});

test('mismatched array lengths are rejected with 400', async () => {
  for (const path of ['/pay', '/pay/calldata']) {
    const res = await post(path, { ...body, signatures: ['0xaa01'] });
    assert.equal(res.status, 400, path);
    assert.match((await res.json()).error, /same length/);
  }
});

test('malformed input is rejected with 400', async () => {
  assert.equal((await post('/pay/calldata', { ...body, account: '0x1234' })).status, 400);
  assert.equal((await post('/pay/calldata', { ...body, auth: { ...body.auth, expiry: String(2n ** 64n) } })).status, 400);
  assert.equal((await fetch(`${base}/pay/calldata`, { method: 'POST', body: '{' })).status, 400);
});

test('/pay without a configured key is 503, /health is 200', async () => {
  assert.equal((await post('/pay', body)).status, 503);
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
});

test('anvil end-to-end against PaymentModule', { skip: 'waiting for PaymentModule deployment' }, () => {});
