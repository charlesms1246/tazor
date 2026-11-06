import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult, getAddress, keccak256, recoverAddress, slice,
  type Abi, type Address, type Hex,
} from 'viem';
import { decodeInvoiceLink } from '../../../packages/pay/src/core.ts';
import { paymentModuleV2Abi } from '../../web/lib/abi/PaymentModuleV2.ts';
import { createHandler } from '../src/app.ts';
import { SimulationFailed } from '../src/sender.ts';
import { ADDRESSES, ROLE_APPROVER, ensRegistryAbi, erc20Abi, factoryAbi, financingAbi, mandateV2Abi, mirrorOperatorAbi, paymentV2Abi, revocationV2Abi } from '../src/sandbox/abi.ts';
import { sandboxFromEnv, type SandboxConfig } from '../src/sandbox/config.ts';
import { createRateLimiter } from '../src/sandbox/ratelimit.ts';
import { createSandbox, type From, type Net, type SandboxPorts } from '../src/sandbox/service.ts';
import type { SyncResult } from '../src/sync.ts';

const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const ENV = {
  SANDBOX_ACCOUNT: '0x00000000000000000000000000000000000000aa',
  SANDBOX_REGISTRY: '0x00000000000000000000000000000000000000e5',
  SANDBOX_SUPPLIER: '0x00000000000000000000000000000000000000bb',
  MIRROR_OPERATOR: '0x00000000000000000000000000000000000000c0',
  SANDBOX_OPERATOR_KEY: key(1), SANDBOX_ADMIN_KEY: key(2), SANDBOX_RAVI_KEY: key(3), SANDBOX_SUPPLIER_KEY: key(4), SANDBOX_FINANCIER_KEY: key(5),
};
const config = sandboxFromEnv(ENV).config!;
const predict = (signer: Hex): Address => getAddress(slice(keccak256(signer), 12));
const VISITOR_SIGNER = '0x000000000000000000000000000000000000f00d' as Hex;
const VISITOR = predict(VISITOR_SIGNER);
const OTHER_MANDATE = `0x${'01'.repeat(32)}` as Hex;
const GOOD_MANDATE = `0x${'02'.repeat(32)}` as Hex;
const allAbis = [factoryAbi, mirrorOperatorAbi, ensRegistryAbi, revocationV2Abi, paymentV2Abi, mandateV2Abi, financingAbi, erc20Abi] as Abi[];

type Sent = { net: Net; from: From; to: Address; fn: string; args: readonly unknown[] };

/** An in-memory Whitechain + Sepolia: just the state the sandbox reads and the writes it makes. */
function fakeChain(c: SandboxConfig) {
  const s = {
    deployed: new Set<string>(), souls: new Map<string, bigint>(), roles: new Map<string, bigint>(), cache: new Map<string, bigint>(),
    revoked: new Set<string>(), now: Date.parse('2026-11-06T12:00:00Z'), sent: [] as Sent[], syncCalls: 0, l2SeesAfter: 1,
    failNext: null as string | null, listing: 300_000n, dueDate: 0n,
    /** syncs that are sent but prove an L1 block from before the grant (the cache stays as it was) */
    staleProofs: 0, unmined: new Map<string, () => void>(), waited: [] as Hex[],
  };
  const lc = (a: string) => a.toLowerCase();
  const reads: Record<string, (args: readonly unknown[]) => unknown> = {
    predictAddress: ([signers]) => predict((signers as Hex[])[0]),
    webAuthnVerifier: () => '0x111C0a6300000000000000000000000000000000',
    soulOf: ([a]) => s.souls.get(lc(a as string)) ?? 0n,
    soulAttributeValue: () => '0x0000000000000000000000000000000000000001',
    isAddressUsed: ([a]) => s.souls.has(lc(a as string)),
    roles: ([, a]) => s.roles.get(lc(a as string)) ?? 0n,
    registryOf: ([a]) => ([c.account, c.supplier].some((x) => lc(x) === lc(a as string)) ? c.registry : '0x0000000000000000000000000000000000000000'),
    invoiceDigest: ([auth]) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [(auth as { invoiceHash: Hex }).invoiceHash, 1n])),
    runDigest: ([auths]) => keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [(auths as { invoiceHash: Hex }[]).map((a) => a.invoiceHash)])),
    isRevoked: ([acct, a]) => s.revoked.has(`${lc(acct as string)}:${lc(a as string)}`),
    revokeDigest: ([acct, t, d]) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [acct as Address, t as Address, d as bigint])),
    mandateOf: ([id]) => ({ account: id === GOOD_MANDATE ? c.account : '0x0000000000000000000000000000000000000bad', payee: c.supplier, cancelled: false }),
    available: () => 50_000n,
    claims: ([id]) => [id === 7n ? c.account : '0x0000000000000000000000000000000000000bad', s.dueDate, 400_000n],
    listings: () => s.listing,
    allowance: () => 0n,
    balanceOf: () => 2_500_000n,
    configV2Of: () => ({ registry: c.registry, twoApproverThreshold: 500_000n, perPaymentLimit: 1_000_000n, monthlyLimit: 5_000_000n, agentMonthlyCap: 0n }),
    windowAvailable: () => [4_000_000n, 0n],
    remainingToday: () => 17n,
    rolesOf: ([, a]) => [s.cache.get(lc(a as string)) ?? 0n, 100n],
  };
  let txn = 0;
  const ports: SandboxPorts = {
    read: async <T>(net: Net, _to: Address, _abi: Abi, fn: string, args: readonly unknown[] = []) => {
      if (net === 'sepolia' && s.failNext === 'sepolia-read') throw new Error('HTTP request failed. Status: 401\nURL: https://rpc.example');
      const r = reads[fn];
      if (!r) throw new Error(`unexpected read ${fn}`);
      return r(args) as T;
    },
    code: async (a) => (s.deployed.has(lc(a)) ? '0x60' : '0x'),
    async send(net, from, to, data) {
      const d = allAbis.map((abi) => { try { return decodeFunctionData({ abi, data }); } catch { return null; } }).find(Boolean)!;
      if (s.failNext === d.functionName) { s.failNext = null; throw new SimulationFailed(`${d.functionName} reverted`); }
      if (s.failNext === `${d.functionName}:rpc`) { s.failNext = null; throw new Error('nonce too low: next nonce 3, tx nonce 2\nVersion: viem'); }
      const args = (d.args ?? []) as readonly unknown[];
      s.sent.push({ net, from, to, fn: d.functionName, args });
      if (d.functionName === 'createAccount') s.deployed.add(lc(predict((args[0] as Hex[])[0])));
      if (d.functionName === 'registerVerified') s.souls.set(lc(args[0] as string), BigInt(s.souls.size + 1));
      if (d.functionName === 'grantRootRoles') s.roles.set(lc(args[1] as string), args[0] as bigint);
      const hash = `0x${(++txn).toString(16).padStart(64, '0')}` as Hex;
      // a revocation takes effect only once mined (when the relayer waits for it)
      if (d.functionName === 'revoke') s.unmined.set(hash, () => s.revoked.add(`${lc(args[0] as string)}:${lc(args[1] as string)}`));
      return hash;
    },
    async simulate(_net, _from, _to, data) {
      const d = decodeFunctionData({ abi: paymentV2Abi, data });
      const approver = (d.args![2] as Address[])[0];
      if (s.revoked.has(`${lc(c.account)}:${lc(approver)}`)) {
        return { ok: false, error: 'execution reverted', data: encodeErrorResult({ abi: paymentModuleV2Abi, errorName: 'PaymentNotVerified', args: [approver] }) };
      }
      return { ok: true };
    },
    /** Whitechain sees the ENS change only after `l2SeesAfter` polls (it lags L1). */
    async sync(registry, account): Promise<SyncResult> {
      s.syncCalls++;
      const ens = s.roles.get(lc(account)) ?? 0n;
      const cached = s.cache.get(lc(account)) ?? 0n;
      if (cached === ens) return { registry, account, status: 'in-sync', roles: ens, l1Block: 100n };
      if (s.syncCalls <= s.l2SeesAfter) return { registry, account, status: 'pending-l1', roles: cached, l1Block: 99n };
      const tx = `0x${'5'.repeat(63)}${(s.syncCalls % 10).toString()}` as Hex;
      if (s.staleProofs > 0) { s.staleProofs--; return { registry, account, status: 'synced', tx, roles: cached, l1Block: 98n }; }
      s.cache.set(lc(account), ens);
      return { registry, account, status: 'synced', tx, roles: ens, l1Block: 101n };
    },
    wait: async (_net, tx) => { s.waited.push(tx); s.unmined.get(tx)?.(); s.unmined.delete(tx); },
    sleep: async (ms) => { s.now += ms; },
    now: () => s.now,
    hasRelayer: true,
  };
  return { s, ports };
}

let chain: ReturnType<typeof fakeChain>;
let sandbox: ReturnType<typeof createSandbox>;
let server: Server;
let base: string;
before(async () => {
  server = createServer((req, res) => createHandler({ sandbox })(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  chain = fakeChain(config);
  sandbox = createSandbox({ config, ports: chain.ports, syncPollMs: 5_000, syncBudgetMs: 30_000 });
});

const post = async (path: string, b: unknown, ip = '203.0.113.7') => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(b) });
  return { code: r.status, body: (await r.json()) as Record<string, any> };
};
const act = (action: string, params: Record<string, unknown> = {}) => post('/sandbox/counterparty', { action, params });

test('config: disabled unless every SANDBOX_* value is set; /health reports it', async () => {
  const partial = sandboxFromEnv({ ...ENV, SANDBOX_FINANCIER_KEY: '' });
  assert.equal(partial.config, null);
  assert.deepEqual(partial.missing, ['SANDBOX_FINANCIER_KEY']);
  assert.equal(config.account, getAddress(ENV.SANDBOX_ACCOUNT));

  const off = createServer(createHandler({}));
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
  const offBase = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
  assert.deepEqual((await (await fetch(`${offBase}/health`)).json()).sandbox, { enabled: false, account: null, registry: null });
  assert.equal((await fetch(`${offBase}/sandbox/status`)).status, 404);
  off.close();

  const on = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(on.sandbox, { enabled: true, account: config.account, registry: config.registry });
});

test('admit: deploy, soul, ENS role, sync; then idempotent with no new txs', async () => {
  const r = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(r.code, 200);
  assert.equal(r.body.status, 'admitted');
  assert.equal(r.body.ok, true);
  assert.deepEqual([r.body.companyId, r.body.approver, r.body.account, r.body.registry, r.body.supplier, r.body.mandateAccount],
    ['sandbox', VISITOR, config.account, config.registry, config.supplier, config.account]);
  assert.equal(r.body.txs.length, 4);
  assert.deepEqual(r.body.steps.map((x: any) => [x.name, x.status, x.chain]),
    [['deploy', 'done', 'whitechain'], ['soul', 'done', 'whitechain'], ['ens-role', 'done', 'sepolia'], ['sync', 'done', 'whitechain']]);
  assert.match(r.body.steps[2].explorerUrl, /^https:\/\/sepolia\.etherscan\.io\/tx\/0x/);
  assert.deepEqual(chain.s.sent.map((x) => [x.net, x.from, x.fn]),
    [['whitechain', 'relayer', 'createAccount'], ['whitechain', 'operator', 'registerVerified'], ['sepolia', 'operator', 'grantRootRoles']]);
  assert.equal(chain.s.sent[2].args[0], ROLE_APPROVER);

  const again = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(again.body.status, 'admitted');
  assert.deepEqual(again.body.steps.map((x: any) => x.status), ['already', 'already', 'already', 'already']);
  assert.equal(chain.s.sent.length, 3);

  // helper3's body: {approver, account: sandbox}, no signer once the approver is deployed
  const flat = await post('/sandbox/admit', { approver: VISITOR, account: config.account });
  assert.equal((await post('/sandbox/admit', { approver: VISITOR, account: VISITOR })).body.status, 'admitted');
  assert.equal(flat.body.status, 'admitted');
  assert.equal(chain.s.sent.length, 3);
});

test('admit: refuses an account that is not the signer\'s approver account, and a malformed signer', async () => {
  const bad = await post('/sandbox/admit', { approver: '0x0000000000000000000000000000000000001234', signer: VISITOR_SIGNER });
  assert.equal(bad.code, 400);
  assert.match(bad.body.error, /not the approver account/);
  assert.equal((await post('/sandbox/admit', { approver: VISITOR, signer: '0x1234' })).code, 400);
  const undeployed = await post('/sandbox/admit', { approver: VISITOR });
  assert.equal(undeployed.code, 400);
  assert.equal(undeployed.body.ok, false);
  assert.match(undeployed.body.reason, /not deployed yet/);
  assert.equal((await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER, account: '0x0000000000000000000000000000000000000bad' })).code, 403);
  assert.equal(chain.s.sent.length, 0);
});

test('admit: pending-sync when Whitechain lags past the budget; a repeat call resumes without re-sending', async () => {
  chain.s.l2SeesAfter = 100;
  const r = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(r.body.status, 'pending-sync');
  assert.equal(r.body.steps.at(-1).status, 'pending');
  chain.s.l2SeesAfter = 0;
  const again = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(again.body.status, 'admitted');
  assert.deepEqual(again.body.steps.map((x: any) => x.status), ['already', 'already', 'already', 'done']);
  assert.equal(chain.s.sent.length, 3);
});

test('admit: a failed step stops the run and reports the revert', async () => {
  chain.s.failNext = 'registerVerified';
  const r = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(r.body.status, 'failed');
  assert.deepEqual(r.body.steps.map((x: any) => [x.name, x.status]), [['deploy', 'done'], ['soul', 'failed']]);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /registerVerified reverted/);
  assert.match(r.body.steps[1].detail, /registerVerified reverted/);
});

test('rate limits: 3 new admissions per IP per hour (429), 20 per day globally', async () => {
  for (let i = 0; i < 3; i++) {
    const signer = `0x${(0xa000 + i).toString(16).padStart(40, '0')}` as Hex;
    assert.equal((await post('/sandbox/admit', { approver: predict(signer), signer }, '198.51.100.1')).code, 200);
  }
  const signer = `0x${'ab'.repeat(20)}` as Hex;
  const limited = await post('/sandbox/admit', { approver: predict(signer), signer }, '198.51.100.1');
  assert.equal(limited.code, 429);
  assert.ok(limited.body.retryAfterSec > 0);
  assert.equal((await post('/sandbox/admit', { approver: predict(signer), signer }, '198.51.100.2')).code, 200);

  let t = 0;
  const l = createRateLimiter({ perDay: 20, perIpHour: 3, now: () => t });
  for (let i = 0; i < 20; i++) assert.equal(l.take(`10.0.0.${i}`).ok, true);
  assert.equal(l.take('10.0.1.1').ok, false);
  t += 86_400_001;
  assert.equal(l.take('10.0.1.1').ok, true);
});

test('create-invoice: supplier → sandbox link; amounts capped at 1 USDT', async () => {
  const r = await act('create-invoice', { amount: '0.75', description: 'Pallets' });
  assert.equal(r.code, 200);
  assert.equal(r.body.status, 'created');
  const inv = await decodeInvoiceLink(r.body.link);
  assert.equal(inv.buyerAccount, config.account);
  assert.equal(inv.payee, config.supplier);
  assert.equal(inv.amount, 750_000n);
  assert.equal(r.body.invoice.invoiceHash.length, 66);
  assert.equal((await act('create-invoice', { amount: '1.5' })).code, 403);
  assert.equal((await act('create-invoice', { amount: 'lots' })).code, 400);
  assert.equal((await act('nope')).code, 400);
});

test('approve-second: the admin co-signs a sandbox invoice digest; refuses other buyers', async () => {
  const { body } = await act('create-invoice', { amount: '0.40' });
  const r = await act('approve-second', { link: body.link });
  assert.equal(r.body.status, 'approved');
  const { approver, signature } = r.body.approval;
  assert.equal(approver, predict(config.eoas.admin));
  const [signers, sigs] = decodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], signature);
  assert.equal(getAddress(signers[0]), config.eoas.admin);
  assert.equal(await recoverAddress({ hash: r.body.digest, signature: sigs[0] }), config.eoas.admin);

  const run = await act('approve-second', { links: [body.link, (await act('create-invoice')).body.link] });
  assert.equal(run.body.kind, 'run');

  const { createInvoiceLink } = await import('../../../packages/pay/src/core.ts');
  const foreign = await createInvoiceLink({ supplierName: 'X', payee: config.supplier, buyerAccount: '0x0000000000000000000000000000000000000bad', lines: [{ description: 'x', unitPrice: '0.1' }], dueDate: '2026-12-01' });
  assert.equal((await act('approve-second', { link: foreign.url })).code, 403);
  const toVisitor = await createInvoiceLink({ supplierName: 'X', payee: VISITOR, buyerAccount: config.account, lines: [{ description: 'x', unitPrice: '0.1' }], dueDate: '2026-12-01' });
  assert.equal((await act('approve-second', { link: toVisitor.url })).code, 403);
  assert.equal((await act('approve-second', { link: 'https://example.com/pay/#junk' })).code, 400);
});

test('revoke-ravi then ravi-pays: revoked on Whitechain, payment refused, nothing sent for it', async () => {
  const before = await act('ravi-pays');
  assert.equal(before.body.status, 'not-refused');
  const r = await act('revoke-ravi');
  assert.equal(r.body.status, 'sent');
  assert.match(r.body.explorerUrl, /^https:\/\/explorer\.testnet\.whitechain\.io\/tx\/0x/);
  const revoke = chain.s.sent.at(-1)!;
  assert.deepEqual([revoke.from, revoke.to, revoke.fn], ['admin', ADDRESSES.revocationListV2, 'revoke']);
  assert.deepEqual(revoke.args.slice(0, 3), [config.account, predict(config.eoas.ravi), predict(config.eoas.admin)]);
  assert.equal((await act('revoke-ravi')).body.status, 'already-revoked');

  const sentBefore = chain.s.sent.length;
  const pay = await act('ravi-pays', { amount: '0.20' });
  assert.equal(pay.body.status, 'refused');
  assert.equal(pay.body.reason, "Whitechain refused Ravi's payment: Ravi was removed from the company (revocation list); contract error PaymentNotVerified");
  assert.match(pay.body.error, /^PaymentNotVerified\(/);
  assert.equal(pay.body.revoked, true);
  assert.equal(chain.s.sent.length, sentBefore);
});

test('credit-note: the supplier pays the sandbox company from its own account', async () => {
  const r = await act('credit-note', { amount: '0.05' });
  assert.equal(r.body.status, 'sent');
  const tx = chain.s.sent.at(-1)!;
  assert.deepEqual([tx.from, tx.to, tx.fn], ['supplier', ADDRESSES.paymentModuleV2, 'payOne']);
  const auth = tx.args[1] as { account: Address; payee: Address; amount: bigint };
  assert.deepEqual([auth.account, auth.payee, auth.amount], [config.supplier, config.account, 50_000n]);
  assert.deepEqual(tx.args[2], [predict(config.eoas.supplier)]);
});

test('collect: only on sandbox mandates, at most what is available', async () => {
  assert.equal((await act('collect', { mandateId: OTHER_MANDATE })).code, 403);
  assert.equal((await act('collect', { mandateId: '0x12' })).code, 400);
  const r = await act('collect', { mandateId: GOOD_MANDATE, amount: '0.10' });
  assert.equal(r.body.status, 'sent');
  assert.equal(r.body.amount, '0.05');
  assert.deepEqual(chain.s.sent.at(-1)!.args, [GOOD_MANDATE, 50_000n]);
});

test('finance-buy and finance-settle: sandbox claims only, price ≤ 1 USDT, settle only when due', async () => {
  assert.equal((await act('finance-buy', { tokenId: '8' })).code, 403);
  chain.s.listing = 2_000_000n;
  assert.equal((await act('finance-buy', { tokenId: '7' })).code, 403);
  chain.s.listing = 300_000n;
  const buy = await act('finance-buy', { tokenId: '7' });
  assert.equal(buy.body.status, 'sent');
  assert.ok(buy.body.approveTx);
  assert.deepEqual(chain.s.sent.slice(-2).map((x) => [x.from, x.fn]), [['financier', 'approve'], ['financier', 'buy']]);

  chain.s.dueDate = BigInt(Math.floor(chain.s.now / 1000) + 86_400);
  assert.equal((await act('finance-settle', { tokenId: '7' })).body.status, 'not-due');
  chain.s.dueDate = 1n;
  const settle = await act('finance-settle', { tokenId: '7' });
  assert.equal(settle.body.status, 'sent');
  assert.equal(chain.s.sent.at(-1)!.fn, 'settle');
});

test('status: company, people, balances, limits and latest actions', async () => {
  await act('revoke-ravi');
  const r = await (await fetch(`${base}/sandbox/status`)).json();
  assert.equal(r.company.account, config.account);
  assert.equal(r.people.ravi.approver, predict(config.eoas.ravi));
  assert.equal(r.balances.account, '2.5');
  assert.deepEqual(r.limits, { perPayment: '1', monthly: '5', twoApproverThreshold: '0.5', agentMonthlyCap: '0', monthlyAvailable: '4', agentAvailable: '0' });
  assert.equal(r.raviRevoked, true);
  assert.equal(r.soulsRemainingToday, '17');
  assert.equal(r.latest[0].action, 'revoke-ravi');
  assert.ok(r.latest[0].at);
});

test('handlerFromEnv: the sandbox is on only with every SANDBOX_* value', async () => {
  const { handlerFromEnv } = await import('../src/env.ts');
  assert.equal(handlerFromEnv({ MIRROR: '0' }).sandbox, undefined);
  assert.equal(handlerFromEnv({ MIRROR: '0', ...ENV, SANDBOX_RAVI_KEY: 'zz' }).sandbox, undefined);
  assert.equal(handlerFromEnv({ MIRROR: '0', ...ENV }).sandbox?.config.registry, getAddress(ENV.SANDBOX_REGISTRY));
});

test('counterparty: flat bodies, account must be the sandbox, setup mandate/claim ids as defaults', async () => {
  const flat = await post('/sandbox/counterparty', { action: 'collect', mandate: GOOD_MANDATE, account: config.account });
  assert.equal(flat.body.status, 'sent');
  assert.equal(flat.body.ok, true);
  assert.equal((await post('/sandbox/counterparty', { action: 'credit-note', account: '0x0000000000000000000000000000000000000bad' })).code, 403);
  assert.equal((await post('/sandbox/counterparty', { action: 'credit-note', account: config.account })).body.status, 'sent');
  assert.equal((await post('/sandbox/counterparty', { action: 'collect' })).code, 400);

  const withIds = sandboxFromEnv({ ...ENV, SANDBOX_MANDATE_ID: GOOD_MANDATE, SANDBOX_CLAIM_ID: '7', SANDBOX_COMPANY_ID: 'sbx' }).config!;
  sandbox = createSandbox({ config: withIds, ports: chain.ports });
  assert.equal((await post('/sandbox/counterparty', { action: 'collect' })).body.status, 'sent');
  assert.equal((await post('/sandbox/counterparty', { action: 'finance-buy' })).body.status, 'sent');
  assert.equal((await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER })).body.companyId, 'sbx');
});

test('admit: a non-revert send error and an RPC failure are reported specifically, not as a bare upstream error', async () => {
  chain.s.failNext = 'grantRootRoles:rpc';
  const r = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.steps.map((x: any) => [x.name, x.status]), [['deploy', 'done'], ['soul', 'done'], ['ens-role', 'failed']]);
  assert.match(r.body.error, /granted APPROVER.* failed: nonce too low: next nonce 3, tx nonce 2$/);

  // a retry resumes at the failed step
  const again = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(again.body.status, 'admitted');

  chain.s.failNext = 'sepolia-read';
  const signer = `0x${'cd'.repeat(20)}` as Hex;
  const down = await post('/sandbox/admit', { approver: predict(signer), signer });
  assert.equal(down.code, 502);
  assert.equal(down.body.error, 'upstream error: HTTP request failed. Status: 401');
});

test('admit: a sync whose proof predates the grant is not admission; it re-syncs, or answers pending-sync', async () => {
  chain.s.staleProofs = 1;
  const r = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(r.body.status, 'admitted');
  assert.equal(chain.s.waited.length, 2, 'waited for both sync txs, re-reading the cache after each');
  assert.equal(r.body.steps.at(-1).status, 'done');

  chain = fakeChain(config);
  sandbox = createSandbox({ config, ports: chain.ports, syncPollMs: 5_000, syncBudgetMs: 30_000 });
  chain.s.staleProofs = 1_000; // every proof stale: the cache never gets APPROVER
  const stale = await post('/sandbox/admit', { approver: VISITOR, signer: VISITOR_SIGNER });
  assert.equal(stale.body.status, 'pending-sync');
  assert.equal(stale.body.ok, true);
  assert.equal(stale.body.steps.at(-1).status, 'pending');
  assert.ok(chain.s.waited.length <= 7, `bounded by the budget, not one sync per loop (${chain.s.waited.length})`);
});

test('revoke-ravi answers only after the revocation is mined, so ravi-pays right after is refused', async () => {
  const r = await act('revoke-ravi');
  assert.equal(r.body.status, 'sent');
  assert.deepEqual(chain.s.waited, [r.body.tx]);
  assert.equal((await act('ravi-pays')).body.status, 'refused');
});
