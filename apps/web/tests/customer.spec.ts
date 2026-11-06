import { test, expect, type Page } from '@playwright/test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, stringToBytes, toFunctionSelector, toHex, verifyTypedData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkoutAbi, depositAbi, cancelTypedData } from '../lib/checkout.ts';
import * as F from './checkout-fixtures.ts';
import { mockExplorer } from './explorer-mock.ts';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const ALL = [...checkoutAbi, ...depositAbi];
const MIRROR = '0x9822650A99bD33F29E383345F570dAE1e4E00928';
type Ev = { eventName: string; args: Record<string, unknown>; data: Hex; block: number; tx: Hex };
const raw = (e: Ev, address: string, i: number) => ({ address, topics: encodeEventTopics({ abi: ALL, eventName: e.eventName as never, args: e.args as never }) as Hex[], data: e.data, blockNumber: toHex(e.block), transactionHash: e.tx, logIndex: toHex(i) });

/** Whitechain mock: range- and topic-filtered eth_getLogs over the fixture events, payment()/subscription() views, and a WB Soul mirror. */
async function chain(page: Page, o: { extra?: Ev[]; subPayer?: string; verified?: string[] } = {}) {
  const logs = [...F.events.map((e, i) => raw(e, F.CHECKOUT, i)), ...(o.extra ?? []).map((e, i) => raw(e, F.CHECKOUT, 50 + i)), ...F.depositEvents.map((e, i) => raw(e, F.DEPOSIT, 100 + i))];
  await mockExplorer(page, { [F.DEPOSIT]: F.depositExplorerItems(), [F.CHECKOUT]: F.explorerItems() });
  await page.route('https://rpc.testnet.whitechain.io/', (route) => {
    const { id, method, params } = route.request().postDataJSON();
    const ok = (result: unknown) => route.fulfill(json({ jsonrpc: '2.0', id, result }));
    if (method === 'eth_blockNumber') return ok(toHex(12_500_000));
    if (method === 'eth_getLogs') {
      const q = params[0]; const from = Number(BigInt(q.fromBlock)); const to = Number(BigInt(q.toBlock));
      return ok(logs.filter((l) => l.address.toLowerCase() === q.address.toLowerCase() && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to
        && (q.topics ?? []).every((t: string | null, i: number) => t === null || (l.topics[i] ?? '').toLowerCase() === t.toLowerCase())));
    }
    if (method === 'eth_getBlockByNumber') return ok({ number: params[0] === 'safe' || params[0] === 'finalized' ? toHex(12_400_050) : params[0], timestamp: toHex(1_794_002_400) });
    if (method === 'eth_call') {
      const to = String(params[0].to).toLowerCase(); const data = params[0].data as Hex;
      if (to === MIRROR.toLowerCase()) {
        if (data.startsWith(toFunctionSelector('soulOf(address)'))) return ok(encodeAbiParameters([{ type: 'uint256' }], [(o.verified ?? []).some((v) => data.toLowerCase().endsWith(v.slice(2).toLowerCase())) ? 7n : 0n]));
        return ok(`0x${'00'.repeat(19)}01${'00'.repeat(12)}`);
      }
      if (to === F.DEPOSIT.toLowerCase()) { const { args } = decodeFunctionData({ abi: depositAbi, data }); return ok(args![0] === F.DEP_ORDER ? F.depositPaymentResult() : `0x${'00'.repeat(192)}`); }
      if (to === F.CHECKOUT.toLowerCase()) {
        const { functionName, args } = decodeFunctionData({ abi: checkoutAbi, data });
        if (functionName === 'payment') return ok(args![0] === F.ORDER ? F.paymentResult() : encodeFunctionResult({ abi: checkoutAbi, functionName: 'payment', result: [F.OTHER, F.PAYER, 9_000_000n, 0n, 1_794_003_600n, 0] as never }));
        if (functionName === 'subscription') return ok(encodeFunctionResult({ abi: checkoutAbi, functionName: 'subscription', result: [F.BLUEJAY, o.subPayer ?? F.PAYER, 1_000_000n, 60, 3, 1, 1_794_002_400n, true] as never }));
        if (functionName === 'nextChargeAt') return ok(encodeFunctionResult({ abi: checkoutAbi, functionName: 'nextChargeAt', result: 4_000_000_000n }));
      }
      return ok(`0x${'00'.repeat(192)}`);
    }
    return ok(null);
  });
}

test('/me/: a customer sees every payment across businesses, refunds received, net, and subscriptions; a pasted address is read only', async ({ page }) => {
  await chain(page);
  await page.route('http://relayer.test/**', (r) => r.fulfill(json({})));
  await page.goto(`/me/?address=${F.PAYER}`);
  await expect(page.getByTestId('me-source')).toHaveText('Your records come from Whitechain: no account, no merchant login.');
  await expect(page.getByTestId('me-order-row')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('me-paid')).toHaveText('10.55 USDT');
  await expect(page.getByTestId('me-refunded')).toHaveText('0.50 USDT');
  await expect(page.getByTestId('me-net')).toHaveText('10.05 USDT');
  const bj = page.getByTestId('me-order-row').filter({ hasText: 'Bluejay' });
  await expect(bj).toContainText('1.05 USDT');
  await expect(bj.getByTestId('me-receipt')).toHaveAttribute('href', `/receipt/?order=${F.ORDER.toLowerCase()}`);
  await expect(page.getByTestId('me-sub-row')).toContainText('1 of 3');
  await expect(page.getByTestId('me-sub-row')).toContainText('Connect this wallet to cancel');
  await expect(page.getByTestId('me-cancel')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(F.ORDER);

  // an exchange payment shows for its refund address
  await page.goto(`/me/?address=${F.REFUND_TO}`);
  await expect(page.getByTestId('me-order-row')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId('me-order-row')).toContainText('Sent from an exchange or wallet');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('/me/: with the demo wallet in this browser, the customer cancels a subscription by signing; the relayer submits', async ({ page }) => {
  const pk = generatePrivateKey();
  const me = privateKeyToAccount(pk).address;
  const SUB2 = keccak256(stringToBytes('demo sub'));
  const sub: Ev = { eventName: 'Subscribed', args: { id: SUB2, merchant: F.BLUEJAY, payer: me }, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint32' }, { type: 'uint16' }, { type: 'bytes32' }], [1_000_000n, 60, 3, keccak256(stringToBytes('plan'))]), block: 12_400_500, tx: `0x${'ab'.repeat(32)}` };
  await chain(page, { extra: [sub], subPayer: me });
  const posted: Record<string, string>[] = [];
  await page.route('http://relayer.test/checkout/cancel', async (r) => { posted.push(r.request().postDataJSON()); await r.fulfill(json({ ok: true, txHash: `0x${'cc'.repeat(32)}` })); });
  await page.addInitScript((k) => localStorage.setItem('tazor.demo-wallet.v1', k), pk);
  await page.goto('/me/');
  await page.getByTestId('me-use-demo').click();
  await expect(page.getByTestId('me-address')).toContainText('Demo wallet in this browser');
  await page.getByTestId('me-cancel').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Subscription cancelled' })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0].by.toLowerCase()).toBe(me.toLowerCase());
  const td = cancelTypedData(SUB2, F.CHECKOUT as Hex);
  expect(await verifyTypedData({ ...(td as object), address: me, signature: posted[0].signature as Hex } as never)).toBe(true);
});

test('/receipt/: verified-business badge, "Request a refund" with a one-click link, and the link prefills the refund on /checkout/', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await chain(page, { verified: [F.BLUEJAY] });
  await page.route('http://relayer.test/**', (r) => r.fulfill(json({ items: [] })));
  await page.addInitScript(() => { if (!localStorage.getItem('tazor.company.v1')) localStorage.setItem('tazor.company.v1', 'bluejay'); });
  await page.goto(`/receipt/?order=${F.ORDER}&ref=BJ-77`);
  const badge = page.getByTestId('receipt-merchant').getByTestId('merchant-badge');
  await expect(badge).toHaveAttribute('data-verified', 'true');
  await expect(badge).toContainText('Verified business · WhiteBIT (WB Soul, simulated on testnet)');
  await expect(page.getByTestId('receipt-my-payments')).toHaveAttribute('href', `/me/?address=${F.PAYER}`);

  await page.getByTestId('rr-open').click();
  await page.getByTestId('rr-amount').fill('5');
  await expect(page.getByTestId('rr-error')).toContainText('At most 1.05 USDT');
  await page.getByTestId('rr-amount').fill('0.40');
  await page.getByTestId('rr-reason').fill('One box arrived damaged');
  const text = (await page.getByTestId('rr-text').textContent())!;
  expect(text).toContain('refund for order BJ-77, paid 1.55 USDT');
  expect(text).toContain('Amount: 0.40 USDT');
  expect(text).toContain('Reason: One box arrived damaged');
  const link = text.match(/https?:\/\/\S+\/checkout\/\?\S+/)![0];
  expect(link).toBe(`http://localhost:4173/checkout/?merchant=${F.BLUEJAY}&tab=orders&order=${F.ORDER.toLowerCase()}&refund=0.40`);
  await expect(page.getByTestId('rr-whatsapp')).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
  await page.getByTestId('rr-copy').click();
  await expect(page.getByTestId('rr-last')).toContainText('Refund requested just now');
  await page.reload();
  await expect(page.getByTestId('rr-last')).toContainText('Refund requested just now');

  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByTestId('co-refund-amount')).toHaveValue('0.4', { timeout: 10_000 });
  await expect(page.getByTestId('co-refund-confirm')).toBeFocused();
});

test('/paylink/: an unverified business shows a calm warning; a verified one the badge', async ({ page }) => {
  await chain(page, { verified: [F.BLUEJAY] });
  await page.route('http://relayer.test/**', (r) => r.fulfill(json({})));
  await page.goto(`/paylink/?m=${F.OTHER}&a=1&ref=X-1`);
  await expect(page.getByTestId('merchant-badge')).toHaveAttribute('data-verified', 'false');
  await expect(page.getByTestId('merchant-badge')).toContainText('Not verified: check the business before paying large amounts');
  await page.goto(`/paylink/?m=${F.BLUEJAY}&a=1&ref=X-2`);
  await expect(page.getByTestId('merchant-badge')).toHaveAttribute('data-verified', 'true');
});
