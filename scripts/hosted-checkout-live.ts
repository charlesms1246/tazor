// Live proof of the hosted checkout through @tazor/pay and the Tazor relayer (not direct contract calls):
// a fresh 0-WBT customer pays an order with one signature → the merchant refunds part of it with one signature →
// the relayer reports the order's finality stage → the signed webhooks for both events verify with the demo secret.
//
//   FUNDER_KEY=… MERCHANT_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/hosted-checkout-live.ts
// FUNDER_KEY only sends the customer test USDT. Writes scripts/checkout-live/hosted-last-run.json. Exit 0 = PASS.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWalletClient, http, parseAbi, type Hex } from '../packages/pay/node_modules/viem/_esm/index.js';
import { generatePrivateKey, privateKeyToAccount } from '../packages/pay/node_modules/viem/_esm/accounts/index.js';
import { accountSigner, getOrder, orderRef, payOrder, refundOrder, USDT } from '../packages/pay/src/checkout.ts';
import { verifyWebhook } from '../packages/pay/src/webhooks.ts';

const RELAYER = process.env.RELAYER_URL ?? 'https://tazor-relayer.vercel.app';
const RPC = 'https://rpc.testnet.whitechain.io';
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return (v.startsWith('0x') ? v : `0x${v}`) as Hex; };
const funder = privateKeyToAccount(need('FUNDER_KEY'));
const merchant = privateKeyToAccount(need('MERCHANT_KEY'));
const customer = privateKeyToAccount(generatePrivateKey());
const chain = { id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const w = createWalletClient({ chain, transport: http(RPC), account: funder });

console.log(`customer (new, 0 WBT) ${customer.address}\nmerchant ${merchant.address}`);
await w.writeContract({ address: USDT, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [customer.address, 150_000n] });
await new Promise((r) => setTimeout(r, 4000));

const order = { merchant: merchant.address, amount: 120_000n, ref: orderRef(`BJ-HOSTED-${Date.now()}`), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
const t0 = Date.now();
const paid = await payOrder({ order, wallet: accountSigner(customer), relayerUrl: RELAYER });
const payMs = Date.now() - t0;
console.log(`  paid via relayer      ${paid.explorer} (${payMs} ms)`);
const refund = await refundOrder({ id: paid.orderId ?? paid.id, amount: 20_000n, wallet: accountSigner(merchant), relayerUrl: RELAYER });
console.log(`  refunded 0.02 USDT    ${refund.explorer}`);
const status = await getOrder((paid.orderId ?? paid.id) as Hex, { relayerUrl: RELAYER });
console.log(`  order status          ${status.status} · stage ${status.stage}`);

const recent = await (await fetch(`${RELAYER}/webhooks/recent?merchant=${merchant.address}`)).json() as { storage: string; items: { type: string; rawBody: string; signature: string }[] };
const ours = recent.items.filter((i) => i.rawBody.includes(paid.txHash) || i.rawBody.includes(refund.txHash));
const checked = await Promise.all(ours.map(async (i) => ({ type: i.type, verified: await verifyWebhook(i.rawBody, i.signature, 'whsec_tazor_demo_test', 86_400) })));
for (const c of checked) console.log(`  webhook ${c.type.padEnd(14)} signature ${c.verified ? 'verified ✓' : 'INVALID'}`);
const types = new Set(checked.filter((c) => c.verified).map((c) => c.type));
const ok = status.status === 'partially-refunded' && types.has('order.paid') && types.has('order.refunded');

mkdirSync('scripts/checkout-live', { recursive: true });
writeFileSync('scripts/checkout-live/hosted-last-run.json', `${JSON.stringify({
  ranAt: new Date().toISOString(), relayer: RELAYER, customer: customer.address, merchant: merchant.address, payMs,
  pay: paid.explorer, refund: refund.explorer, status: status.status, stage: status.stage, webhookStorage: recent.storage, webhooks: checked, pass: ok,
}, null, 2)}\n`);
if (!ok) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
