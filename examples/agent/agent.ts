// An AI procurement agent that buys a freight quote over x402: it holds only USDT (no WBT) and has a hard spend cap.
//   AGENT_KEY=0x… node --experimental-strip-types --disable-warning=ExperimentalWarning examples/agent/agent.ts
//   DRY_RUN=1 … only shows the price asked (nothing is signed or paid).
// Env: AGENT_KEY (never commit one), RELAYER_URL (default Tazor's), MAX_USDT (default 0.01).
import { privateKeyToAccount } from '../../packages/pay/node_modules/viem/_esm/accounts/index.js';
import { accountSigner, EXPLORER, RELAYER_URL } from '../../packages/pay/src/checkout.ts';
import { payFetch, pickRequirement } from '../../packages/pay/src/x402.ts';

const base = (process.env.RELAYER_URL || RELAYER_URL).replace(/\/+$/, '');
const url = `${base}/x402/demo/freight-quote`;
const cap = BigInt(Math.round(Number(process.env.MAX_USDT ?? '0.01') * 1e6));
const fail = (m: string): never => { console.error(`FAIL  ${m}`); process.exit(1); };

if (process.env.DRY_RUN === '1') {
  const r = await fetch(url);
  if (r.status !== 402) fail(`expected 402, got ${r.status}`);
  const req = pickRequirement(((await r.json()) as { accepts?: never[] }).accepts ?? []);
  if (!req) fail('no USDT-on-Whitechain requirement offered');
  console.log(`Price ${Number(req!.maxAmountRequired) / 1e6} USDT to ${req!.payTo}; cap ${Number(cap) / 1e6} USDT; ${BigInt(req!.maxAmountRequired) <= cap ? 'would pay' : 'would REFUSE'}. DRY RUN: nothing signed.`);
  process.exit(0);
}
const raw = process.env.AGENT_KEY?.trim() || fail('AGENT_KEY is not set');
const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`);
console.log(`Agent ${account.address} · spend cap ${Number(cap) / 1e6} USDT`);
const { response, paid } = await payFetch(url, { account: accountSigner(account), maxValue: cap }).catch((e) => fail((e as Error).message));
if (!response.ok) fail(`the server answered ${response.status}: ${await response.text()}`);
console.log('Quote', JSON.stringify(await response.json(), null, 2));
if (paid) console.log(`Paid ${Number(paid.value) / 1e6} USDT${paid.settlement?.transaction ? ` · ${EXPLORER}/tx/${paid.settlement.transaction}` : ''}`);
