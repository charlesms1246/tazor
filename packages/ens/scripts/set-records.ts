// Sets Tazor's demo ENS records on Ethereum Sepolia: company text records and ENSIP-11 Whitechain addresses,
// and member subnames with an ETH address and a name text record.
// Usage: PRIVATE_KEY=0x… node --experimental-strip-types scripts/set-records.ts [--send]
// Without --send it only prints and simulates the planned calls; a dry run can use SIGNER=0x… instead of a key.
// Calls whose record already holds the target value (read through the UniversalResolver) are skipped, so re-runs
// only send what is missing. Before each send it waits until the account has nothing pending on this RPC.
import { BaseError, createPublicClient, getAddress, http, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { SEPOLIA } from '../src/company.ts';
import {
  DEMO_RECORDS, ETH_COIN_TYPE, WHITECHAIN_SEPOLIA_COIN_TYPE, alreadySet, isRetryable, memberRegistryAbi, recordCalls,
  registerMemberCall, type Call, type Expect,
} from '../src/records.ts';

const UNIVERSAL_RESOLVER = '0x24e1d8e068620b647ca097f961a61055f4f42d72';
const POLL_MS = 3000;
const NONCE_WAIT_MS = 120_000;
const RETRIES = 3;

const SEND = process.argv.includes('--send');
const RPC = process.env.SEPOLIA_RPC || 'https://sepolia.gateway.tenderly.co';
const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const hasKey = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);
if (SEND && !hasKey) { console.error('--send needs PRIVATE_KEY (0x + 64 hex) in the environment'); process.exit(1); }
if (!hasKey && !process.env.SIGNER) { console.error('set PRIVATE_KEY, or SIGNER=0x… for a dry run'); process.exit(1); }
const signer = hasKey ? privateKeyToAccount(key!) : null;
const account = { address: signer ? signer.address : getAddress(process.env.SIGNER!) };
const pub = createPublicClient({ chain: sepolia, transport: http(RPC, { retryCount: 3, retryDelay: 1500 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ''}`.trim() : String(e));

console.log(`${SEND ? 'SEND' : 'DRY RUN'} on Sepolia via ${RPC} as ${account.address}`);

const plan: Call[] = [];
const afterRegister: Call[] = [];
for (const c of DEMO_RECORDS) {
  const name = `${c.label}.taz0r.eth`;
  plan.push(...recordCalls(name, c.texts, [[WHITECHAIN_SEPOLIA_COIN_TYPE, c.whitechainAccount]]));
  if (c.members.length === 0) continue;
  const registry = getAddress(await pub.readContract({ address: SEPOLIA.parentRegistry, abi: memberRegistryAbi, functionName: 'getSubregistry', args: [c.label] }));
  if (registry === zeroAddress) { console.log(`! ${name} has no subregistry; skipping members`); continue; }
  for (const m of c.members) {
    const owner = await pub.readContract({ address: registry, abi: memberRegistryAbi, functionName: 'findOwner', args: [m.label] });
    if (owner === zeroAddress) plan.push(registerMemberCall(registry, m.label, m.address, name));
    else console.log(`= ${m.label}.${name} already registered to ${owner}`);
    afterRegister.push(...recordCalls(`${m.label}.${name}`, { name: m.name }, [[ETH_COIN_TYPE, m.address]]));
  }
}
const calls = [...plan, ...afterRegister];

/** Current value of the record a call would set, through the UniversalResolver; null if unset or unreadable. */
async function current(e: Expect): Promise<string | null> {
  try {
    return e.kind === 'text'
      ? await pub.getEnsText({ name: e.name, key: e.key, universalResolverAddress: UNIVERSAL_RESOLVER })
      : await pub.getEnsAddress({ name: e.name, coinType: e.coinType, universalResolverAddress: UNIVERSAL_RESOLVER });
  } catch {
    return null;
  }
}

async function simulate(c: Call): Promise<string> {
  try {
    await pub.call({ account: account.address, to: c.to, data: c.data });
    return 'ok';
  } catch (e) {
    return `REVERTS: ${msg(e)}`;
  }
}

/** Waits until nonce(latest) == nonce(pending) for the account on this RPC, then returns it. */
async function settledNonce(): Promise<number> {
  const until = Date.now() + NONCE_WAIT_MS;
  for (;;) {
    const [latest, pending] = await Promise.all([
      pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      pub.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    ]);
    if (latest === pending) return latest;
    if (Date.now() > until) throw new Error(`account still has ${pending - latest} pending tx after ${NONCE_WAIT_MS / 1000} s`);
    console.log(`    waiting: ${pending - latest} pending tx (nonce latest ${latest}, pending ${pending})`);
    await sleep(POLL_MS);
  }
}

async function send(c: Call): Promise<`0x${string}`> {
  let last = '';
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const nonce = await settledNonce();
      const [gas, fees] = await Promise.all([pub.estimateGas({ account: account.address, to: c.to, data: c.data }), pub.estimateFeesPerGas()]);
      const raw = await signer!.signTransaction({
        chainId: sepolia.id, type: 'eip1559', to: c.to, data: c.data, nonce, gas: (gas * 12n) / 10n,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`);
      console.log(`    tx ${hash} (nonce ${nonce}) success · gas ${receipt.gasUsed}`);
      return hash;
    } catch (e) {
      last = msg(e);
      if (!isRetryable(last) || attempt === RETRIES) break;
      const wait = 5000 * 2 ** (attempt - 1);
      console.log(`    retry ${attempt}/${RETRIES - 1} in ${wait / 1000} s: ${last.slice(0, 160)}`);
      await sleep(wait);
    }
  }
  throw new Error(last);
}

const summary = { sent: [] as string[], skipped: [] as string[], failed: [] as string[], planned: [] as string[] };
for (const [i, c] of calls.entries()) {
  const label = `${String(i + 1).padStart(2)}. ${c.describe}`;
  if (c.expect) {
    const now = await current(c.expect);
    if (alreadySet(c.expect, now)) {
      console.log(`${label}  [skip: already set]`);
      summary.skipped.push(c.describe);
      continue;
    }
  }
  const sim = await simulate(c);
  console.log(`${label}  [${sim}]`);
  if (!SEND) { (sim === 'ok' ? summary.planned : summary.failed).push(c.describe); continue; }
  if (sim.startsWith('REVERTS')) { summary.failed.push(`${c.describe}: ${sim}`); continue; }
  try {
    await send(c);
    summary.sent.push(c.describe);
  } catch (e) {
    console.log(`    FAILED: ${msg(e).slice(0, 200)}`);
    summary.failed.push(`${c.describe}: ${msg(e).slice(0, 200)}`);
  }
}

console.log('\nSummary');
if (SEND) console.log(`  sent ${summary.sent.length}`);
else console.log(`  would send ${summary.planned.length}`);
console.log(`  skipped (already set) ${summary.skipped.length}`);
console.log(`  failed ${summary.failed.length}`);
for (const f of summary.failed) console.log(`    - ${f}`);
if (!SEND) console.log('Dry run only; re-run with --send to broadcast.');
process.exit(summary.failed.length ? 1 : 0);
