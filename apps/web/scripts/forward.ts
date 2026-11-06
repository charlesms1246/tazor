/**
 * Sends a Tazor signed payment through Ethereum (EnsGate.forward on Sepolia) without Tazor's site or servers,
 * then waits for the delivery on Whitechain.
 *
 *   FORWARD_PRIVATE_KEY=0x… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/forward.ts '<tazor-signed-payment:1:…>'
 *   pbpaste | DRY_RUN=1 node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/forward.ts      # simulate only
 *
 * Env: FORWARD_PRIVATE_KEY (any Sepolia account with test ETH; never printed), SEPOLIA_RPC (default tenderly),
 * WC_RPC (default Whitechain Sepolia), DRY_RUN=1 (eth_call simulation, nothing sent).
 */
import { createPublicClient, createWalletClient, http, parseAbiItem, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { decodeSignedPayment, forwardCalldata } from '../lib/signed-payment.ts';
import { usdtText } from '../lib/human.ts';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC || 'https://sepolia.gateway.tenderly.co';
const WC_RPC = process.env.WC_RPC || 'https://rpc.testnet.whitechain.io';
const DRY = process.env.DRY_RUN === '1';
const invoicePaid = parseAbiItem('event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1)');
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function readBlob(): Promise<string> {
  if (process.argv[2]) return process.argv[2];
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

const fail = (m: string): never => { console.error(`FAIL  ${m}`); process.exit(1); };

const blob = await readBlob();
const p = (() => { try { return decodeSignedPayment(blob); } catch (e) { return fail((e as Error).message); } })();
const data = forwardCalldata(p);
const l1 = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const l2 = createPublicClient({ transport: http(WC_RPC) });
if ((await l1.getChainId()) !== 11155111) fail('SEPOLIA_RPC is not Ethereum Sepolia');
if ((await l2.getChainId()) !== p.whitechainChainId) fail(`WC_RPC is not chain ${p.whitechainChainId}`);

console.log(`Company   ${p.label}.taz0r.eth (${short(p.account)})`);
console.log(`Pays      ${usdtText(BigInt(p.auth.amount))} to ${p.supplier ? `${p.supplier} (${short(p.auth.payee)})` : short(p.auth.payee)}${p.invoiceId ? ` for ${p.invoiceId}` : ''}`);
console.log(`Approvers ${p.approvers.map(short).join(', ')}`);
console.log(`EnsGate   ${p.gate} on Sepolia`);

const raw = process.env.FORWARD_PRIVATE_KEY?.trim();
const account = raw ? privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex) : null;
try {
  await l1.call({ account: account?.address, to: p.gate, data });
  console.log('Simulation: Ethereum accepts it (the approvers hold the approver role on ENS). Whitechain checks the signatures when it arrives.');
} catch (e) {
  fail(`Ethereum would refuse it: ${(e as Error).message.split('\n')[0]}`);
}
if (DRY) { console.log('DRY RUN: nothing sent.'); process.exit(0); }
if (!account) fail('FORWARD_PRIVATE_KEY is not set (any Sepolia account with a little test ETH).');

const wallet = createWalletClient({ account: account!, chain: sepolia, transport: http(SEPOLIA_RPC) });
const fromBlock = (await l2.getBlockNumber()) - 20n;
const gas = await l1.estimateGas({ account: account!.address, to: p.gate, data });
const hash = await wallet.sendTransaction({ to: p.gate, data, gas: (gas * 12n) / 10n });
const started = Date.now();
console.log(`Sent      https://sepolia.etherscan.io/tx/${hash}`);
const r = await l1.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (r.status !== 'success') fail('the Sepolia transaction reverted');
console.log('Waiting for Whitechain to pick up the deposit (about a minute)…');
for (let i = 0; i < 120; i++) {
  const logs = await l2.getLogs({ address: p.paymentModule, event: invoicePaid, args: { account: p.account, nonce: BigInt(p.auth.nonce) }, fromBlock });
  const hit = logs.find((l) => l.args.viaL1);
  if (hit) {
    console.log(`Delivered https://explorer.testnet.whitechain.io/tx/${hit.transactionHash} in ${Math.round((Date.now() - started) / 1000)} s`);
    console.log('RESULT: PASS');
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 10_000));
}
fail('not delivered on Whitechain within 20 minutes');
