// Live proof of TazorDepositCheckout on Whitechain Sepolia with the official USDT: a customer pays an order with a
// plain USDT transfer to the order's own deposit address (what an exchange withdrawal does), including 0.05 too much;
// anyone settles; the merchant gets exactly the order amount and the excess goes back in the same transaction.
//
//   SUBMITTER_KEY=… MERCHANT_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/deposit-live.ts
// SUBMITTER_KEY also plays the sender (the "exchange"). Writes scripts/checkout-live/deposit-last-run.json. Exit 0 = PASS.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from '../packages/pay/node_modules/viem/_esm/index.js';
import { generatePrivateKey, privateKeyToAccount } from '../packages/pay/node_modules/viem/_esm/accounts/index.js';

const RPC = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const EXPLORER = 'https://explorer.testnet.whitechain.io';
const USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const DC: Address = (process.env.DEPOSIT_CHECKOUT as Address) ?? '0xcb3515398C8Cd9459a1Dce75aB42ec664a07B3ab';
const chain = { id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return (v.startsWith('0x') ? v : `0x${v}`) as Hex; };
const submitter = privateKeyToAccount(need('SUBMITTER_KEY'));
const merchant = privateKeyToAccount(need('MERCHANT_KEY'));
const refundTo = privateKeyToAccount(generatePrivateKey()).address; // the customer's own address, given at checkout

const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account: submitter });
const erc20 = parseAbi(['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const abi = parseAbi([
  'struct DepositOrder { address merchant; uint256 amount; bytes32 ref; uint64 deadline; address refundTo; }',
  'function depositAddress(DepositOrder o) view returns (address)',
  'function orderId(DepositOrder o) view returns (bytes32)',
  'function settle(DepositOrder o) returns (bytes32)',
]);
const steps: { step: string; tx: Hex; url: string; ms: number }[] = [];
async function send(step: string, address: Address, a: unknown, functionName: string, args: unknown[]) {
  const t0 = Date.now();
  const hash = await wallet.writeContract({ address, abi: a as typeof abi, functionName: functionName as never, args: args as never });
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 500 });
  if (r.status !== 'success') throw new Error(`${step} reverted: ${hash}`);
  steps.push({ step, tx: hash, url: `${EXPLORER}/tx/${hash}`, ms: Date.now() - t0 });
  console.log(`  ${step.padEnd(34)} ${EXPLORER}/tx/${hash}`);
}
const bal = (a: Address) => pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [a] });

const order = {
  merchant: merchant.address, amount: 200_000n, ref: keccak256(toHex(`CAFE-${Date.now()}`)),
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), refundTo,
};
const addr = await pub.readContract({ address: DC, abi, functionName: 'depositAddress', args: [order] });
const id = await pub.readContract({ address: DC, abi, functionName: 'orderId', args: [order] });
console.log(`deposit address (nothing deployed yet): ${addr}\nrefund address: ${refundTo}`);
const m0 = await bal(merchant.address);
await send('plain transfer 0.25 USDT (0.05 extra)', USDT, erc20, 'transfer', [addr, 250_000n]);
await send('settle (anyone)', DC, abi, 'settle', [order]);
const got = (await bal(merchant.address)) - m0;
const back = await bal(refundTo);
if (got !== 200_000n || back !== 50_000n || (await bal(addr)) !== 0n) throw new Error(`unexpected balances: merchant +${got}, refund ${back}`);
mkdirSync('scripts/checkout-live', { recursive: true });
writeFileSync('scripts/checkout-live/deposit-last-run.json', `${JSON.stringify({ ranAt: new Date().toISOString(), contract: DC, orderId: id, depositAddress: addr, refundTo, merchant: merchant.address, merchantReceived: '200000', excessReturned: '50000', steps }, null, 2)}\n`);
console.log('PASS — merchant +0.20 USDT, 0.05 excess returned to the customer in the same transaction');
