// Live proof of TazorCheckout on Whitechain Sepolia with the official USDT and a payer that holds 0 WBT:
//   pay (one EIP-3009 signature) → partial refund (merchant signature) → subscribe (3009 + EIP-2612 permit)
//   → charge cycle 2 when due → cancel by signature → charging again reverts.
// The payer is a brand-new key every run; the submitter (SUBMITTER_KEY, paying WBT gas) plays the relayer.
//
// Run from the repo root:
//   SUBMITTER_KEY=… MERCHANT_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/checkout-live.ts
// Writes scripts/checkout-live/last-run.json. Exit 0 = PASS.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address, type Hex,
} from '../packages/pay/node_modules/viem/_esm/index.js';
import { generatePrivateKey, privateKeyToAccount } from '../packages/pay/node_modules/viem/_esm/accounts/index.js';

const RPC = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const EXPLORER = 'https://explorer.testnet.whitechain.io';
const USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const CHECKOUT: Address = (process.env.CHECKOUT as Address) ?? '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670';
const chain = {
  id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return (v.startsWith('0x') ? v : `0x${v}`) as Hex; };
const submitter = privateKeyToAccount(need('SUBMITTER_KEY'));
const merchant = privateKeyToAccount(need('MERCHANT_KEY'));
const payer = privateKeyToAccount(generatePrivateKey());

const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account: submitter });

const erc20 = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
]);
const abi = parseAbi([
  'struct Order { address merchant; uint256 amount; bytes32 ref; uint64 deadline; }',
  'struct Plan { address merchant; uint256 amount; uint32 period; uint16 cycles; bytes32 ref; }',
  'struct Auth { uint256 validAfter; uint256 validBefore; bytes sig; }',
  'function payNonce(Order o) view returns (bytes32)',
  'function orderId(Order o) view returns (bytes32)',
  'function refundNonce(bytes32 id, uint256 amount, uint256 refundNo) pure returns (bytes32)',
  'function subId(Plan p, address payer) view returns (bytes32)',
  'function subNonce(Plan p, address payer) view returns (bytes32)',
  'function pay(Order o, address payer, uint256 validAfter, uint256 validBefore, bytes sig) returns (bytes32)',
  'function refund(bytes32 id, uint256 amount, uint256 validAfter, uint256 validBefore, bytes sig)',
  'function subscribe(Plan p, address payer, Auth first, Auth allowance) returns (bytes32)',
  'function charge(bytes32 id)',
  'function cancelBySig(bytes32 id, address by, bytes sig)',
  'function payment(bytes32 id) view returns (address merchant, address payer, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)',
  'function nextChargeAt(bytes32 id) view returns (uint64)',
]);

const usdtDomain = { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT } as const;
const receiveTypes = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const sign3009 = (acct: typeof payer, value: bigint, validBefore: bigint, nonce: Hex) =>
  acct.signTypedData({ domain: usdtDomain, types: receiveTypes, primaryType: 'ReceiveWithAuthorization',
    message: { from: acct.address, to: CHECKOUT, value, validAfter: 0n, validBefore, nonce } });

const steps: { step: string; tx: Hex; url: string; gasUsed: string; ms: number }[] = [];
async function send(step: string, fn: string, args: unknown[], to: Address = CHECKOUT, a: unknown = abi) {
  const t0 = Date.now();
  const hash = await wallet.writeContract({ address: to, abi: a as typeof abi, functionName: fn as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 500 });
  if (r.status !== 'success') throw new Error(`${step} reverted: ${hash}`);
  const row = { step, tx: hash, url: `${EXPLORER}/tx/${hash}`, gasUsed: r.gasUsed.toString(), ms: Date.now() - t0 };
  steps.push(row);
  console.log(`  ${step.padEnd(28)} ${row.url}  (${row.ms} ms)`);
  return r;
}
const usdtOf = (a: Address) => pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [a] });
const now = () => BigInt(Math.floor(Date.now() / 1000));

console.log(`payer (new, 0 WBT): ${payer.address}\nmerchant: ${merchant.address}\ncheckout: ${CHECKOUT}`);
await send('fund payer 0.60 USDT', 'transfer', [payer.address, 600_000n], USDT, erc20);

// 1. pay
const order = { merchant: merchant.address, amount: 250_000n, ref: keccak256(toHex(`BJ-LIVE-${Date.now()}`)), deadline: now() + 3600n };
const id = await pub.readContract({ address: CHECKOUT, abi, functionName: 'orderId', args: [order] });
const payN = await pub.readContract({ address: CHECKOUT, abi, functionName: 'payNonce', args: [order] });
const vb = now() + 1800n;
const m0 = await usdtOf(merchant.address);
await send('pay 0.25 USDT (3009)', 'pay', [order, payer.address, 0n, vb, await sign3009(payer, order.amount, vb, payN)]);
if ((await usdtOf(merchant.address)) - m0 !== order.amount) throw new Error('merchant did not receive the order amount');

// 2. partial refund, signed by the merchant
const rn = await pub.readContract({ address: CHECKOUT, abi, functionName: 'refundNonce', args: [id, 100_000n, 0n] });
const p0 = await usdtOf(payer.address);
await send('refund 0.10 USDT to payer', 'refund', [id, 100_000n, 0n, vb, await sign3009(merchant, 100_000n, vb, rn)]);
if ((await usdtOf(payer.address)) - p0 !== 100_000n) throw new Error('payer did not get the refund');
const pay = await pub.readContract({ address: CHECKOUT, abi, functionName: 'payment', args: [id] });

// 3. subscribe: 0.05 USDT every 30 s, 3 cycles; permit covers the 2 later cycles
const plan = { merchant: merchant.address, amount: 50_000n, period: 30, cycles: 3, ref: keccak256(toHex(`LANE-${Date.now()}`)) };
const sid = await pub.readContract({ address: CHECKOUT, abi, functionName: 'subId', args: [plan, payer.address] });
const sn = await pub.readContract({ address: CHECKOUT, abi, functionName: 'subNonce', args: [plan, payer.address] });
const permitNonce = await pub.readContract({ address: USDT, abi: erc20, functionName: 'nonces', args: [payer.address] });
const permitDeadline = now() + 3600n;
const permitSig = await payer.signTypedData({
  domain: usdtDomain, primaryType: 'Permit',
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  message: { owner: payer.address, spender: CHECKOUT, value: 100_000n, nonce: permitNonce, deadline: permitDeadline },
});
await send('subscribe (cycle 1 + permit)', 'subscribe', [plan, payer.address,
  { validAfter: 0n, validBefore: vb, sig: await sign3009(payer, plan.amount, vb, sn) },
  { validAfter: 100_000n, validBefore: permitDeadline, sig: permitSig }]);

// 4. charge cycle 2 when due
const due = await pub.readContract({ address: CHECKOUT, abi, functionName: 'nextChargeAt', args: [sid] });
const wait = Number(due - now()) + 3;
if (wait > 0) { console.log(`  waiting ${wait}s for cycle 2…`); await new Promise((r) => setTimeout(r, wait * 1000)); }
await send('charge cycle 2 (pull)', 'charge', [sid]);

// 5. the payer cancels by signature (no WBT)
const cancelSig = await payer.signTypedData({
  domain: { name: 'TazorCheckout', version: '1', chainId: 1874, verifyingContract: CHECKOUT },
  types: { Cancel: [{ name: 'subId', type: 'bytes32' }] }, primaryType: 'Cancel', message: { subId: sid },
});
await send('cancel by payer signature', 'cancelBySig', [sid, payer.address, cancelSig]);
let blocked = false;
try { await pub.simulateContract({ address: CHECKOUT, abi, functionName: 'charge', args: [sid], account: submitter.address }); } catch { blocked = true; }
if (!blocked) throw new Error('charge after cancel did not revert');
console.log('  charge after cancel           reverts (NotActive) ✓');

const payerWbt = await pub.getBalance({ address: payer.address });
if (payerWbt !== 0n) throw new Error('payer unexpectedly holds WBT');
const out = {
  ranAt: new Date().toISOString(), checkout: CHECKOUT, usdt: USDT, payer: payer.address, payerWbt: '0', merchant: merchant.address,
  orderId: id, subscriptionId: sid, payment: { amount: pay[2].toString(), refunded: pay[3].toString(), refunds: pay[5] }, steps,
};
mkdirSync('scripts/checkout-live', { recursive: true });
writeFileSync('scripts/checkout-live/last-run.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(`PASS — payer never held WBT. Receipt: scripts/checkout-live/last-run.json`);
