import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { USDT_DOMAIN, authorizationTypes } from '../src/checkout/abi.ts';
import { erc20Abi } from '../src/sandbox/abi.ts';
import { sandboxFromEnv } from '../src/sandbox/config.ts';
import { COMMERCE_DAILY_CAP } from '../src/sandbox/commerce.ts';
import { createSandbox, type SandboxPorts } from '../src/sandbox/service.ts';

const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const ENV = {
  SANDBOX_ACCOUNT: '0x00000000000000000000000000000000000000aa', SANDBOX_REGISTRY: '0x00000000000000000000000000000000000000e5',
  SANDBOX_SUPPLIER: '0x00000000000000000000000000000000000000bb', MIRROR_OPERATOR: '0x00000000000000000000000000000000000000c0',
  SANDBOX_OPERATOR_KEY: key(1), SANDBOX_ADMIN_KEY: key(2), SANDBOX_RAVI_KEY: key(3), SANDBOX_SUPPLIER_KEY: key(4), SANDBOX_FINANCIER_KEY: key(5),
};
const config = sandboxFromEnv(ENV).config!;
const CHECKOUT = getAddress('0x8ce727e6b4099b68f667b1ffecad7e1beb511670');
const DEPOSIT = getAddress('0xcb3515398c8cd9459a1dce75ab42ec664a07b3ab');
const VAULT = getAddress('0x00000000000000000000000000000000000000fa');
const PAY_TO = getAddress('0xc1dce946d192e344251972470237f1471c93876c');
const NOW = 1_800_000_000;
const NONCE = `0x${'7a'.repeat(32)}` as Hex;

function world() {
  const s = { supplierBalance: 5_000_000n, transfers: [] as { to: Address; amount: bigint }[], payments: new Map<string, readonly unknown[]>(), budget: 0 };
  let n = 0;
  const ports: SandboxPorts = {
    async read<T>(_net: unknown, _to: Address, _abi: unknown, fn: string, args: readonly unknown[] = []) {
      const r: Record<string, () => unknown> = {
        balanceOf: () => s.supplierBalance, payNonce: () => NONCE, refundNonce: () => NONCE, depositAddress: () => VAULT,
        payment: () => s.payments.get(String(args[0])) ?? ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0],
      };
      return r[fn]() as T;
    },
    code: async () => '0x',
    async send(_net, from, _to, data) {
      assert.equal(from, 'supplier', 'only the supplier wallet funds');
      const d = decodeFunctionData({ abi: erc20Abi, data });
      s.transfers.push({ to: d.args![0] as Address, amount: d.args![1] as bigint });
      return `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
    },
    simulate: async () => ({ ok: true }), wait: async () => {}, sleep: async () => {}, now: () => NOW * 1000, hasRelayer: true,
  };
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const checkout = {
    address: CHECKOUT,
    pay: async (body: Record<string, unknown>) => { calls.push({ kind: 'pay', body }); return { ok: true, txHash: `0x${'ab'.repeat(32)}`, orderId: `0x${'0d'.repeat(32)}` }; },
    refund: async (body: Record<string, unknown>) => { calls.push({ kind: 'refund', body }); return { ok: true, txHash: `0x${'cd'.repeat(32)}`, orderId: body.id }; },
  };
  const x402 = { settle: async (body: Record<string, unknown>) => { calls.push({ kind: 'x402', body }); return { success: true, transaction: `0x${'ef'.repeat(32)}`, network: 'whitechain-sepolia', payer: '0x' }; } };
  const sandbox = createSandbox({
    config, ports,
    commerce: { checkout: checkout as never, deposit: { address: DEPOSIT } as never, x402: x402 as never, x402PayTo: PAY_TO, budget: async () => { s.budget++; } },
  });
  return { s, sandbox, calls };
}
const recover = (primaryType: 'ReceiveWithAuthorization' | 'TransferWithAuthorization', m: Record<string, unknown>, signature: Hex) =>
  recoverTypedDataAddress({ domain: USDT_DOMAIN, types: authorizationTypes, primaryType, message: m as never, signature });

test('checkout-customer-pay: a fresh customer funded with 0.12 USDT signs a 3009 receive to CHECKOUT with payNonce; the relayer pays', async () => {
  const { s, sandbox, calls } = world();
  const r = await sandbox.counterparty({ action: 'checkout-customer-pay', merchant: '0x0000000000000000000000000000000000000Bad' });
  assert.equal(r.status, 'paid');
  assert.equal(r.orderId, `0x${'0d'.repeat(32)}`);
  const customer = r.customer as Address;
  assert.deepEqual(s.transfers, [{ to: customer, amount: 120_000n }]);
  const body = calls[0].body as { order: { merchant: string; amount: string }; payer: Address; validAfter: string; validBefore: string; signature: Hex };
  assert.deepEqual([body.order.merchant, body.order.amount, body.payer], [getAddress('0x0000000000000000000000000000000000000bad'), '120000', customer]);
  const signer = await recover('ReceiveWithAuthorization', { from: customer, to: CHECKOUT, value: 120_000n, validAfter: BigInt(body.validAfter), validBefore: BigInt(body.validBefore), nonce: NONCE }, body.signature);
  assert.equal(signer, customer, 'the customer itself signed exactly this authorization');
  assert.equal(s.budget, 1);
  const def = await sandbox.counterparty({ action: 'checkout-customer-pay' });
  assert.equal(def.merchant, config.eoas.supplier, 'default merchant: the sandbox supplier wallet');
  assert.notEqual(def.customer, customer, 'a new customer key per call');
});

test('checkout-merchant-refund: the supplier key signs only for orders paid to it, within what is left', async () => {
  const { s, sandbox, calls } = world();
  const id = `0x${'01'.repeat(32)}`;
  s.payments.set(id, [config.eoas.supplier, '0x0000000000000000000000000000000000000c01', 120_000n, 0n, BigInt(NOW), 0]);
  const r = await sandbox.counterparty({ action: 'checkout-merchant-refund', orderId: id });
  assert.equal(r.status, 'refunded');
  const body = calls[0].body as { amount: string; refundNo: string; validAfter: string; validBefore: string; signature: Hex };
  assert.deepEqual([body.amount, body.refundNo], ['20000', '0']);
  assert.equal(await recover('ReceiveWithAuthorization', { from: config.eoas.supplier, to: CHECKOUT, value: 20_000n, validAfter: BigInt(body.validAfter), validBefore: BigInt(body.validBefore), nonce: NONCE }, body.signature), config.eoas.supplier);
  s.payments.set(`0x${'02'.repeat(32)}`, ['0x0000000000000000000000000000000000000bad', '0x0000000000000000000000000000000000000c01', 120_000n, 0n, BigInt(NOW), 0]);
  await assert.rejects(sandbox.counterparty({ action: 'checkout-merchant-refund', orderId: `0x${'02'.repeat(32)}` }), /refund from your own wallet/);
  await assert.rejects(sandbox.counterparty({ action: 'checkout-merchant-refund', orderId: id, amount: '0.2' }), /at most 0.12 USDT/);
});

test('deposit-customer-pay: a plain transfer of the order amount to its deposit address (nothing else); returns the order link param', async () => {
  const { s, sandbox } = world();
  const r = await sandbox.counterparty({ action: 'deposit-customer-pay', amount: '0.10' });
  assert.equal(r.status, 'transferred');
  assert.deepEqual(s.transfers, [{ to: VAULT, amount: 100_000n }]);
  const order = JSON.parse(Buffer.from(String(r.orderParam), 'base64url').toString());
  assert.deepEqual([order.merchant, order.amount, order.refundTo], [config.eoas.supplier, '100000', config.eoas.supplier]);
  const given = { merchant: PAY_TO, amount: '50000', ref: `0x${'cc'.repeat(32)}`, deadline: String(NOW + 600), refundTo: PAY_TO };
  const r2 = await sandbox.counterparty({ action: 'deposit-customer-pay', order: given });
  assert.equal(s.transfers[1].amount, 50_000n, 'an order created by the page is paid exactly');
  assert.equal((r2.order as { ref: string }).ref, given.ref);
});

test('agent-x402: a fresh agent funded with 0.01 signs a TransferWithAuthorization to payTo and settles through the facilitator', async () => {
  const { s, sandbox, calls } = world();
  const r = await sandbox.counterparty({ action: 'agent-x402', from: 'Mumbai', to: 'Pune' });
  assert.equal(r.status, 'paid');
  assert.equal((r.quote as { distanceKm: number }).distanceKm, 148);
  assert.deepEqual(s.transfers, [{ to: r.agent, amount: 10_000n }]);
  const b = calls[0].body as { paymentPayload: { payload: { signature: Hex; authorization: Record<string, string> } }; paymentRequirements: { payTo: string; maxAmountRequired: string } };
  const a = b.paymentPayload.payload.authorization;
  assert.deepEqual([b.paymentRequirements.payTo, b.paymentRequirements.maxAmountRequired, a.to, a.value], [PAY_TO, '10000', PAY_TO, '10000']);
  assert.equal(await recover('TransferWithAuthorization', { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }, b.paymentPayload.payload.signature), r.agent);
});

test('commerce caps: low supplier balance is a clear refusal (nothing sent); each action has a daily cap; amounts capped at 1 USDT', async () => {
  const { s, sandbox } = world();
  s.supplierBalance = 5_000n;
  await assert.rejects(sandbox.counterparty({ action: 'agent-x402' }), /supplier wallet .* has 0.005 USDT, needs 0.01 USDT: top it up/);
  assert.equal(s.transfers.length, 0);
  await assert.rejects(sandbox.counterparty({ action: 'checkout-customer-pay', amount: '1.5' }), /at most 1 USDT/);
  s.supplierBalance = 10_000_000n;
  for (let i = 0; i < COMMERCE_DAILY_CAP['deposit-customer-pay']; i++) await sandbox.counterparty({ action: 'deposit-customer-pay' });
  await assert.rejects(sandbox.counterparty({ action: 'deposit-customer-pay' }), /at most 30 times a day/);
});
