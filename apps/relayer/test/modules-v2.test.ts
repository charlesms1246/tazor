import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { createHandler } from '../src/app.ts';
import { MANDATE_MODULE_V2 } from '../src/mandate.ts';
import { PAYMENT_MODULE_V2 } from '../src/payrun.ts';
import { REVOCATION_LIST_V2 } from '../src/revoke-list.ts';

const MM1 = getAddress('0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32');
const RL1 = getAddress('0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e');
const V2_CO = getAddress('0xE6eE20A68d9053d8Bc3F8bb99Dc255c1de5b7116');
const V1_CO = getAddress('0x18d15B034C645dbbFCb9c68238A14D059f632513');
const ID_V2 = `0x${'22'.repeat(32)}` as Hex;
const ID_V1 = `0x${'11'.repeat(32)}` as Hex;
const ID_NONE = `0x${'33'.repeat(32)}` as Hex;

/** A Whitechain read fake: V2_CO is configured on PaymentModuleV2; ID_V2 lives on MandateModuleV2, ID_V1 on v1. */
const client = {
  readContract: async (a: { address: Address; functionName: string; args: readonly unknown[] }) => {
    if (a.functionName === 'registryOf') {
      assert.equal(a.address, PAYMENT_MODULE_V2);
      return a.args[0] === V2_CO ? '0x00000000000000000000000000000000000000e5' : zeroAddress;
    }
    if (a.functionName === 'mandateOf') {
      const id = a.args[0];
      const here = (a.address === MANDATE_MODULE_V2 && id === ID_V2) || (a.address === MM1 && id === ID_V1);
      return { account: here ? V2_CO : zeroAddress };
    }
    throw new Error(`unexpected ${a.functionName}`);
  },
};

async function serve() {
  const sent: { to: Address; data: Hex }[] = [];
  const sender = { address: zeroAddress, send: async (to: Address, data: Hex) => { sent.push({ to, data }); return `0x${'ab'.repeat(32)}` as Hex; } };
  const s = createServer(createHandler({ sender: sender as never, client: client as never, mandateModule: MM1, revocationList: RL1 }));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { code: r.status, body: await r.json() };
  };
  return { s, sent, post };
}

const mandate = (account: Address) => ({
  mandate: { account, payee: '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6', capPerPeriod: '300000', period: '2592000', expiry: '1801719053', nonce: '1' },
  approvers: ['0x00aBed5bDddf794c415eE746d3E4De5332cC5450'], signatures: ['0xabcdef'],
});

test('/mandate: a v2 company goes to MandateModuleV2, a v1 company to v1; the response names the module', async () => {
  const { s, sent, post } = await serve();
  const v2 = await post('/mandate', mandate(V2_CO));
  assert.equal(v2.code, 200);
  assert.equal(v2.body.mandateModule, MANDATE_MODULE_V2);
  assert.equal(sent[0].to, MANDATE_MODULE_V2);
  const v1 = await post('/mandate', mandate(V1_CO));
  assert.equal(v1.body.mandateModule, MM1);
  assert.equal(sent[1].to, MM1);
  assert.equal(sent[0].data, sent[1].data.replace(V1_CO.slice(2).toLowerCase(), V2_CO.slice(2).toLowerCase()), 'same calldata ABI on both modules');
  s.close();
});

test('/pull: sent to the module that holds the mandate id; an unknown id is 400 with nothing sent', async () => {
  const { s, sent, post } = await serve();
  assert.equal((await post('/pull', { mandateId: ID_V2, amount: '100000' })).body.mandateModule, MANDATE_MODULE_V2);
  assert.equal((await post('/pull', { mandateId: ID_V1, amount: '100000' })).body.mandateModule, MM1);
  const none = await post('/pull', { mandateId: ID_NONE, amount: '1' });
  assert.equal(none.code, 400);
  assert.match(none.body.error, /unknown mandate/);
  assert.deepEqual(sent.map((x) => x.to), [MANDATE_MODULE_V2, MM1]);
  s.close();
});

test('/revoke without a list: RevocationListV2 for a v2 company, v1 otherwise; an explicit list still wins', async () => {
  const { s, sent, post } = await serve();
  const body = (account: Address, list?: Address) => ({
    account, target: '0x0689A8a6BE28ffC10762e003969f094bc3A996b3', admin: '0x98632A8B3364F1E27F8D6F0c9Dea86d6B8117d0c', deadline: '1801719053', sig: '0xabcd',
    ...(list ? { list } : {}),
  });
  await post('/revoke', body(V2_CO));
  await post('/revoke', body(V1_CO));
  await post('/revoke', body(V2_CO, RL1));
  assert.deepEqual(sent.map((x) => x.to), [REVOCATION_LIST_V2, RL1, RL1]);
  s.close();
});

test('/pay/calldata: names PaymentModuleV2 for a v2 company, v1 otherwise', async () => {
  const s = createServer(createHandler({ client: client as never, paymentModule: '0xe19ddf1fd417B146137A5dE6eb56c4589431540A' }));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const body = (account: Address) => ({
    account, auth: { invoiceHash: `0x${'aa'.repeat(32)}`, account, payee: '0x0000000000000000000000000000000000000003', amount: '1', expiry: '2000000000', nonce: '7' },
    approvers: ['0x00000000000000000000000000000000000a11ce'], signatures: ['0xaa01'],
  });
  const call = async (a: Address) => (await (await fetch(`${base}/pay/calldata`, { method: 'POST', body: JSON.stringify(body(a)) })).json()).to;
  assert.equal(await call(V2_CO), PAYMENT_MODULE_V2);
  assert.equal(await call(V1_CO), '0xe19ddf1fd417B146137A5dE6eb56c4589431540A');
  s.close();
});
