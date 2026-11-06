// Live proof that renewals run by themselves: a fresh 0-WBT customer subscribes through the hosted relayer
// (0.03 USDT every 60 s, 3 cycles), then the relayer's cron (GET /watch, Bearer CRON_SECRET) charges cycle 2 once due.
//   FUNDER_KEY=… MERCHANT=0x… CRON_SECRET=… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/subscription-cron-live.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWalletClient, http, parseAbi, type Address, type Hex } from '../packages/pay/node_modules/viem/_esm/index.js';
import { generatePrivateKey, privateKeyToAccount } from '../packages/pay/node_modules/viem/_esm/accounts/index.js';
import { accountSigner, orderRef, readSubscription, subscribe, USDT } from '../packages/pay/src/checkout.ts';

const RELAYER = process.env.RELAYER_URL ?? 'https://tazor-relayer.vercel.app';
const RPC = 'https://rpc.testnet.whitechain.io';
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const funder = privateKeyToAccount((need('FUNDER_KEY').startsWith('0x') ? need('FUNDER_KEY') : `0x${need('FUNDER_KEY')}`) as Hex);
const customer = privateKeyToAccount(generatePrivateKey());
const chain = { id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
await createWalletClient({ chain, transport: http(RPC), account: funder }).writeContract({
  address: USDT, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [customer.address, 100_000n],
});
await new Promise((r) => setTimeout(r, 4000));
const plan = { merchant: need('MERCHANT') as Address, amount: 30_000n, period: 60, cycles: 3, ref: orderRef(`PLAN-${Date.now()}`) };
const sub = await subscribe({ plan, wallet: accountSigner(customer), relayerUrl: RELAYER });
const id = (sub.subId ?? sub.id) as Hex;
console.log(`  subscribed (cycle 1)   ${sub.explorer}`);
await new Promise((r) => setTimeout(r, 65_000));
const cron = await (await fetch(`${RELAYER}/watch`, { headers: { authorization: `Bearer ${need('CRON_SECRET')}` } })).json() as { subscriptions?: { results?: { subId: string; action: string; tx?: string; txHash?: string }[] } };
const mine = cron.subscriptions?.results?.find((r) => r.subId.toLowerCase() === id.toLowerCase());
console.log(`  cron result            ${JSON.stringify(mine)}`);
const s = await readSubscription(id, { relayerUrl: RELAYER });
const charged = Number((s as { charged?: number | bigint }).charged ?? 0);
mkdirSync('scripts/checkout-live', { recursive: true });
writeFileSync('scripts/checkout-live/subscription-cron-last-run.json', `${JSON.stringify({ ranAt: new Date().toISOString(), customer: customer.address, subId: id, subscribe: sub.explorer, cron: mine, chargedCycles: charged }, null, 2)}\n`);
if (charged < 2) { console.error('FAIL: cycle 2 not charged'); process.exit(1); }
console.log(`PASS — cycle 2 charged by the cron (${charged} of 3)`);
