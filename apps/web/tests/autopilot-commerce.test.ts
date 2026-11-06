import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { REFUND, commerceApi, type CommerceDeps } from '../app/_autopilot/commerce.ts';
import { DEPOSIT_PAID, STORY, checkoutPage } from '../app/_autopilot/story.ts';

const MERCHANT = '0x00000000000000000000000000000000000000Aa' as Address;
const ORDER = `0x${'0d'.repeat(32)}` as Hex;

function deps(o: Partial<CommerceDeps> & { wallet?: CommerceDeps['wallet'] } = {}) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const refunds: unknown[] = [];
  const d: CommerceDeps = {
    client: {
      counterparty: async (action: string, params: Record<string, unknown>) => {
        calls.push({ action, params });
        const bodies: Record<string, unknown> = {
          'checkout-customer-pay': { ok: true, action, status: 'paid', tx: `0x${'ab'.repeat(32)}`, txHash: `0x${'ab'.repeat(32)}`, chain: 'whitechain', detail: 'A customer paid', orderId: ORDER, customer: '0x01', merchant: MERCHANT },
          'checkout-merchant-refund': { ok: true, action, status: 'refunded', txHash: `0x${'cd'.repeat(32)}`, chain: 'whitechain', detail: 'refunded' },
          'deposit-customer-pay': { ok: true, action, status: 'transferred', txHash: `0x${'ef'.repeat(32)}`, chain: 'whitechain', detail: 'sent', orderParam: 'eyJ9', depositAddress: '0x02' },
          'agent-x402': { ok: true, action, status: 'paid', txHash: `0x${'12'.repeat(32)}`, chain: 'whitechain', detail: 'agent paid', payTo: '0x03', quote: { from: 'Mumbai', to: 'Pune', distanceKm: 148, priceINR: 7716, transitDays: 1 } },
        };
        return { httpStatus: 200, body: bodies[action] };
      },
    } as never,
    relayer: () => 'https://relayer.test',
    wallet: o.wallet ?? (async () => null),
    refund: async (a) => { refunds.push(a); return { txHash: `0x${'99'.repeat(32)}` as Hex }; },
    fetch: o.fetch,
  };
  return { api: commerceApi(d), calls, refunds };
}

test('Checkout chapter: no wallet → the sandbox merchant receives and signs the refund; ids land in ctx', async () => {
  const { api, calls } = deps();
  const w = await api.walletAddress();
  assert.deepEqual(w.data, { merchantWallet: '', refundBy: 'sandbox' });
  const pay = await api.customerPays(w.data!);
  assert.deepEqual([pay.ok, pay.tx, pay.data!.orderId, pay.data!.merchant], [true, `0x${'ab'.repeat(32)}`, ORDER, MERCHANT]);
  assert.deepEqual(calls[0], { action: 'checkout-customer-pay', params: { merchant: '' } });
  const r = await api.refund({ ...w.data!, ...pay.data! });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[1], { action: 'checkout-merchant-refund', params: { orderId: ORDER, amount: '0.02' } });
  const agent = await api.agentPays();
  assert.equal(agent.data!.quote, 'Mumbai → Pune: 148 km, ₹7716, 1 day(s)');
  assert.equal(agent.data!.payTo, '0x03');
});

test('Checkout chapter: with a browser wallet the presenter is the merchant and their wallet signs the 0.02 refund', async () => {
  const wallet = { address: MERCHANT, signTypedData: async () => '0x' as Hex };
  const { api, calls, refunds } = deps({ wallet: async () => wallet });
  const w = await api.walletAddress();
  assert.deepEqual(w.data, { merchantWallet: MERCHANT, refundBy: 'wallet' });
  await api.customerPays(w.data!);
  assert.deepEqual(calls[0].params, { merchant: MERCHANT });
  const r = await api.refund({ ...w.data!, orderId: ORDER, merchant: MERCHANT });
  assert.equal(r.tx, `0x${'99'.repeat(32)}`);
  assert.deepEqual(refunds, [{ id: ORDER, amount: REFUND, wallet, method: 'signed', relayer: 'https://relayer.test' }]);
  const wrong = await api.refund({ ...w.data!, orderId: ORDER, merchant: '0x00000000000000000000000000000000000000Bb' });
  assert.match(wrong.error!, /Switch your wallet to the merchant/);
  const declined = deps({ wallet: async () => { throw new Error('User rejected'); } });
  assert.equal((await declined.api.walletAddress()).data!.refundBy, 'sandbox', 'declining the wallet falls back to the sandbox merchant');
});

test('Checkout chapter: deposit status polls until settled; the story retries while not paid', async () => {
  let n = 0;
  const fetch = (async (url: string) => {
    assert.equal(url, 'https://relayer.test/checkout/deposit/status?order=eyJ9');
    n++;
    return new Response(JSON.stringify(n < 2 ? { id: ORDER, status: 'funded' } : { id: ORDER, status: 'paid', payTx: `0x${'77'.repeat(32)}` }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const { api } = deps({ fetch });
  const first = await api.depositStatus({ orderParam: 'eyJ9' });
  assert.deepEqual([first.ok, first.status, first.tx], [true, 'funded', undefined]);
  const second = await api.depositStatus({ orderParam: 'eyJ9' });
  assert.deepEqual([second.status, second.tx, second.data!.depositOrderId], ['paid', `0x${'77'.repeat(32)}`, ORDER]);
  assert.ok(DEPOSIT_PAID.includes('paid'));

  const chapter = STORY.find((s) => s.id === 'checkout')!;
  const retry = chapter.actions.find((a) => a.do === 'api' && a.call.name === 'deposit-status') as { retry: { while: (r: { ok: boolean; status?: string }) => boolean } };
  assert.equal(retry.retry.while({ ok: true, status: 'funded' }), true);
  assert.equal(retry.retry.while({ ok: true, status: 'paid' }), false);
  assert.equal(checkoutPage('0xab', 'webhooks'), '/checkout/?merchant=0xab&tab=webhooks');
  const names = chapter.actions.filter((a) => a.do === 'api').map((a) => (a as { call: { name: string } }).call.name);
  assert.deepEqual(names, ['wallet-address', 'customer-pays', 'merchant-refund', 'deposit-pays', 'deposit-status', 'agent-pays']);
});
