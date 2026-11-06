// Proves @tazor/pay end to end with a REAL Whitechain Sepolia payment:
//   createInvoiceLink → watchPayment (real Blockscout) → pay it as the live demo does (Priya's backup ECDSA key approves,
//   the hosted relayer submits PaymentModuleV2.payRun for acme v2) → onPaid must report the same tx and amount.
//
// Run (from the repo root; needs packages/pay installed: pnpm -C packages/pay install):
//   DRY_RUN=1 node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/sdk-live-check.ts
//   PRIYA_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/sdk-live-check.ts
// Env: PRIYA_KEY (live only; never printed), DRY_RUN, RELAYER_URL, WC_RPC, APP_URL, PRIYA_ACCOUNT, BUYER, PAYEE, AMOUNT, PAID_TIMEOUT_S.
// Writes scripts/sdk-live/last-run.json (live) or scripts/sdk-live/dry-run.json (DRY_RUN). Exit 0 = PASS.
import { mkdirSync, writeFileSync } from 'node:fs';
// viem comes from the SDK's own install (scripts/ has no node_modules)
import {
  createPublicClient, decodeEventLog, encodeAbiParameters, getAddress, http, isAddressEqual, parseAbi, toHex, type Address, type Hex,
} from '../packages/pay/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../packages/pay/node_modules/viem/_esm/accounts/index.js';
import { createInvoiceLink, isPaid, watchPayment, type Payment } from '../packages/pay/src/core.ts';
import { buildInvoiceAuth } from '../apps/web/lib/invoice-auth.ts';
import { defaultAuthParams } from '../apps/web/lib/payment.ts';
import { decodeRunDigest, encodeRunDigestCall, payRunRelayerBody, runDigest } from '../apps/web/lib/runs.ts';
import { decodeConfigV2, encodeConfigV2Of } from '../apps/web/lib/policies.ts';

const env = process.env;
const DRY = env.DRY_RUN === '1';
const RELAYER = (env.RELAYER_URL || 'https://tazor-relayer.vercel.app').replace(/\/+$/, '');
const WC_RPC = env.WC_RPC || 'https://rpc.testnet.whitechain.io';
const APP_URL = env.APP_URL || 'https://tazor-app.vercel.app';
const EXPLORER = 'https://explorer.testnet.whitechain.io';
const PM2 = getAddress('0x906620D82e2959351c81D731C67EA46DF71E36f3');
const USDT = getAddress('0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7');
const BUYER = getAddress(env.BUYER || '0xb99A12652BEe98429ae31EA0529A0b63f1073721'); // acme v2
const PAYEE = getAddress(env.PAYEE || '0xc1dce946D192e344251972470237F1471C93876c'); // Bluejay
const PRIYA = getAddress(env.PRIYA_ACCOUNT || '0x00aBed5bDddf794c415eE746d3E4De5332cC5450'); // Priya's ApproverAccount
const AMOUNT = env.AMOUNT || '0.05';
const PAID_TIMEOUT_MS = Number(env.PAID_TIMEOUT_S || 180) * 1000;
const OUT_DIR = new URL('./sdk-live/', import.meta.url);

const wc = createPublicClient({ transport: http(WC_RPC) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const invoicePaid = parseAbi(['event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1)']);
const tx = (h: string) => `${EXPLORER}/tx/${h}`;
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const log = (s: string) => console.log(s);
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); return ok; };

function write(file: string, data: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(new URL(file, OUT_DIR), `${json(data)}\n`);
  log(`  wrote scripts/sdk-live/${file}`);
}

const runId = `SDK-LIVE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36).toUpperCase()}`;
log(`Tazor SDK live check ${DRY ? '(DRY RUN: no transaction)' : '(LIVE: one real testnet payment)'}  id ${runId}`);
log(`  relayer ${RELAYER} · app ${APP_URL} · Whitechain ${WC_RPC}`);

// 1. the SDK makes the link, exactly as the merchant demo does
const link = await createInvoiceLink({
  supplierName: 'Bluejay Logistics', payee: PAYEE, buyerAccount: BUYER, id: runId, memo: `SDK live check ${runId}`,
  lines: [{ description: 'SDK live check', quantity: 1, unitPrice: AMOUNT }],
  dueDate: new Date(Date.now() + 7 * 86_400_000), appUrl: APP_URL,
});
log(`1. link ${link.url.slice(0, 64)}…  invoiceHash ${link.invoiceHash}  amount ${link.amount} USDT`);

// 2. the app's own auth for that invoice: nonce = invoice hash, so InvoicePaid carries it
const { nonce, expiry } = defaultAuthParams(link.invoice);
const auth = buildInvoiceAuth(link.invoice, nonce, expiry);
check('auth nonce equals the invoice hash', toHex(auth.nonce, { size: 32 }) === link.invoiceHash.toLowerCase());
const digest = runDigest([auth], { chainId: 1874, verifyingContract: PM2, version: '2' });

// preflight (read-only): v2 account, on-chain digest, balance, relayer health
const preflight: Record<string, unknown> = { digest };
try {
  const cfg = decodeConfigV2(await wc.call({ to: PM2, data: encodeConfigV2Of(BUYER) }).then((r) => r.data!));
  check('buyer is a PaymentModuleV2 company', cfg.registry !== '0x0000000000000000000000000000000000000000', `registry ${cfg.registry}`);
  const onchain = decodeRunDigest((await wc.call({ to: PM2, data: encodeRunDigestCall([auth]) })).data!);
  check('on-chain runDigest matches the local digest', onchain.toLowerCase() === digest.toLowerCase(), digest);
  const balance = await wc.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [BUYER] });
  preflight.buyerUsdt = balance;
  check('buyer holds enough USDT', balance >= link.amountBaseUnits, `${Number(balance) / 1e6} USDT`);
} catch (e) {
  check('Whitechain preflight reads', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
}
try {
  const h = await (await fetch(`${RELAYER}/health`, { signal: AbortSignal.timeout(15_000) })).json() as { ok?: boolean; relayer?: string };
  preflight.relayer = h.relayer;
  check('relayer /health ok', h.ok === true, `sender ${h.relayer}`);
} catch (e) {
  check('relayer /health reachable', false, e instanceof Error ? e.message : String(e));
}

// 3. Priya's backup EOA approves the run digest: ApproverAccount signature = abi.encode(bytes[] signers, bytes[] signatures)
const rawKey = env.PRIYA_KEY?.trim();
const key = rawKey ? ((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex) : undefined;
let signature: Hex = '0x';
let priyaEoa: Address | null = null;
if (key) {
  const acct = privateKeyToAccount(key);
  priyaEoa = acct.address;
  signature = encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[acct.address], [await acct.sign({ hash: digest })]]);
} else if (!DRY) {
  log('PRIYA_KEY is not set; it is required for a live run (or use DRY_RUN=1).');
  process.exit(2);
}
const body = payRunRelayerBody(BUYER, [auth], [{ approver: PRIYA, signature: key ? signature : ('0x<signature by PRIYA_KEY>' as Hex) }]);
log(`3. POST ${RELAYER}/payrun  approver ${PRIYA}${priyaEoa ? ` (backup EOA ${priyaEoa})` : ''}`);

if (DRY) {
  log(json(body));
  write('dry-run.json', { id: runId, at: new Date().toISOString(), link: link.url, invoiceHash: link.invoiceHash, amount: link.amount, digest, preflight, checks, relayerBody: body, signed: !!key });
  const ok = checks.every((c) => c.ok);
  log(`${ok ? 'DRY RUN OK' : 'DRY RUN: preflight problems above'} (nothing sent)`);
  process.exit(ok ? 0 : 1);
}

// 4. watch with the SDK (real Blockscout), then submit
let paid: (Payment & { explorerUrl: string }) | null = null;
let tPaid = 0;
const paidPromise = new Promise<void>((resolve) => {
  const stop = watchPayment({
    invoiceHash: link.invoiceHash, payee: PAYEE, intervalMs: 1500,
    onPaid: (p) => { paid = p; tPaid = Date.now(); stop(); resolve(); },
    onError: (e) => log(`  watchPayment: ${e.message} (retrying)`),
  });
  setTimeout(() => { stop(); resolve(); }, PAID_TIMEOUT_MS);
});

const tSubmit = Date.now();
const res = await fetch(`${RELAYER}/payrun`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
});
const relayed = await res.json() as { txHash?: Hex; paymentModule?: string; deployTxs?: Hex[]; error?: string };
const result: Record<string, unknown> = { id: runId, at: new Date(tSubmit).toISOString(), link: link.url, invoiceHash: link.invoiceHash, amount: link.amount, relayer: RELAYER, relayed };
if (!check('relayer accepted the payment', res.ok && !!relayed.txHash, res.ok ? relayed.txHash : `${res.status} ${relayed.error ?? ''}`)) {
  write('last-run.json', { ...result, checks, pass: false });
  log('FAIL');
  process.exit(1);
}
const txHash = relayed.txHash!;
check('relayer chose PaymentModuleV2', !!relayed.paymentModule && isAddressEqual(relayed.paymentModule as Address, PM2), relayed.paymentModule);
log(`4. submitted ${tx(txHash)}`);

const receipt = await wc.waitForTransactionReceipt({ hash: txHash, timeout: 120_000, pollingInterval: 500 });
const tReceipt = Date.now();
const block = await wc.getBlock({ blockNumber: receipt.blockNumber });
check('transaction succeeded', receipt.status === 'success', `block ${receipt.blockNumber}`);
const onChain = receipt.logs.flatMap((l) => {
  if (!isAddressEqual(l.address, PM2)) return [];
  try { return [decodeEventLog({ abi: invoicePaid, data: l.data, topics: l.topics })]; } catch { return []; }
}).find((e) => e.eventName === 'InvoicePaid' && toHex(e.args.nonce, { size: 32 }) === link.invoiceHash.toLowerCase());
check('receipt has InvoicePaid(nonce = invoiceHash) for the amount', !!onChain && onChain.args.amount === link.amountBaseUnits && isAddressEqual(onChain.args.payee, PAYEE));

await paidPromise;
const p = paid as (Payment & { explorerUrl: string }) | null;
check('watchPayment onPaid fired', !!p, p ? undefined : `not within ${PAID_TIMEOUT_MS / 1000} s`);
if (p) {
  check('onPaid tx hash equals the submitted tx', p.txHash.toLowerCase() === txHash.toLowerCase(), p.txHash);
  check('onPaid amount equals the invoice amount', p.amountBaseUnits === link.amountBaseUnits, `${p.amount} USDT`);
}
check('isPaid(invoiceHash) is true', await isPaid(link.invoiceHash, { payee: PAYEE }));

const timings = {
  submitToReceiptMs: tReceipt - tSubmit,
  submitToBlockTimeMs: Number(block.timestamp) * 1000 - tSubmit,
  receiptToOnPaidMs: p ? tPaid - tReceipt : null,
  submitToOnPaidMs: p ? tPaid - tSubmit : null,
};
const pass = checks.every((c) => c.ok);
write('last-run.json', { ...result, txHash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, explorer: tx(txHash), onPaid: p, timings, checks, pass });
log(`5. submit → paid (receipt) ${(timings.submitToReceiptMs / 1000).toFixed(1)} s · paid → onPaid ${timings.receiptToOnPaidMs === null ? '—' : `${(timings.receiptToOnPaidMs / 1000).toFixed(1)} s`} · submit → onPaid ${timings.submitToOnPaidMs === null ? '—' : `${(timings.submitToOnPaidMs / 1000).toFixed(1)} s`}`);
log(`${pass ? 'PASS' : 'FAIL'}  ${tx(txHash)}`);
process.exit(pass ? 0 : 1);
