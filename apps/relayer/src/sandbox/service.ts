import {
  BaseError, decodeErrorResult, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, isAddress, isAddressEqual, isHex, parseUnits,
  size, slice, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { createInvoiceLink, decodeInvoiceLink, type Invoice } from '../../../../packages/pay/src/core.ts';
import { invoiceHash } from '../../../web/lib/invoice.ts';
import { paymentModuleV2Abi as fullPaymentV2Abi } from '../../../web/lib/abi/PaymentModuleV2.ts';
import { revocationListAbi as fullRevocationAbi } from '../../../web/lib/abi/RevocationList.ts';
import { BadRequest } from '../payment.ts';
import { SimulationFailed } from '../sender.ts';
import type { SyncResult } from '../sync.ts';
import {
  EXPLORERS, IS_VERIFIED_ATTRIBUTE, MAX_SANDBOX_AMOUNT, ROLE_APPROVER, ensRegistryAbi, erc20Abi, factoryAbi, financingAbi,
  mandateV2Abi, mirrorOperatorAbi, paymentV2Abi, revocationV2Abi, roleCacheAbi, soulMirrorAbi,
} from './abi.ts';
import type { SandboxConfig, SandboxWho } from './config.ts';
import { createRateLimiter, type RateLimiter } from './ratelimit.ts';

export type Net = 'whitechain' | 'sepolia';
export type From = 'relayer' | SandboxWho;
export type SimResult = { ok: true } | { ok: false; error: string; data?: Hex };

/** Chain access, injected so tests can use fakes. `send` simulates first and throws SimulationFailed on a revert. */
export type SandboxPorts = {
  read<T = unknown>(net: Net, address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<T>;
  code(address: Address): Promise<Hex>;
  send(net: Net, from: From, to: Address, data: Hex): Promise<Hex>;
  simulate(net: Net, from: From, to: Address, data: Hex): Promise<SimResult>;
  /** RoleCache sync (POST /sync logic); absent when the relayer has no prover. */
  sync?: (registry: Address, account: Address) => Promise<SyncResult>;
  /** Resolves when the tx is mined; throws if it reverted or wasn't mined in time. */
  wait(net: Net, tx: Hex): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Whether 'relayer' (RELAYER_PRIVATE_KEY) can send on Whitechain; the operator key pays otherwise. */
  hasRelayer: boolean;
};

/** Refused by sandbox policy (not the sandbox company, over the cap): HTTP 403. */
export class SandboxRefused extends Error {}
/** Too many admissions: HTTP 429. */
export class RateLimited extends Error {
  readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) { super(message); this.retryAfterSec = retryAfterSec; }
}

export type StepStatus = 'done' | 'already' | 'pending' | 'skipped' | 'failed';
export type Step = { name: 'deploy' | 'soul' | 'ens-role' | 'sync'; status: StepStatus; tx: Hex | null; chain: Net; explorerUrl: string | null; detail: string };
type AdmitInner = { status: 'admitted' | 'pending-sync' | 'failed'; account: Address; registry: Address; steps: Step[] };
/**
 * `approver` is the guest's ApproverAccount; `account` is the SANDBOX company account it can now approve for.
 * `ok` is false only when a step failed (`error` says why); pending-sync means call admit again in about a minute.
 */
export type AdmitResult = {
  ok: boolean; status: AdmitInner['status']; companyId: string; approver: Address; account: Address; registry: Address;
  supplier: Address; mandateAccount: Address; txs: Hex[]; steps: Step[]; error?: string;
};

export type ActionResult = {
  action: string; status: string; tx: Hex | null; chain: Net; explorerUrl: string | null; detail: string;
  [extra: string]: unknown;
};
export const ACTIONS = ['create-invoice', 'approve-second', 'revoke-ravi', 'ravi-pays', 'credit-note', 'collect', 'finance-buy', 'finance-settle'] as const;
export type Action = (typeof ACTIONS)[number];

type InvoiceAuth = { invoiceHash: Hex; account: Address; payee: Address; amount: bigint; expiry: bigint; nonce: bigint };

const AUTH_VALIDITY_AFTER_DUE = 30n * 24n * 3600n;
const DEFAULT_AMOUNT = '0.10';
const errorAbi = [...fullPaymentV2Abi, ...fullRevocationAbi] as Abi;

/** A short, key-free reason for a failed chain call (viem's short message plus its details line). */
export function errorText(e: unknown): string {
  if (e instanceof BaseError) return [e.shortMessage, e.details].filter(Boolean).join(' — ').split('\n')[0].slice(0, 300);
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
}

export const txUrl = (net: Net, tx: Hex | null) => (tx ? `${EXPLORERS[net]}/tx/${tx}` : null);
export const addressUrl = (net: Net, a: Address) => `${EXPLORERS[net]}/address/${a}`;
const usdt = (v: bigint) => formatUnits(v, 6);

/** A decimal USDT amount ('0.25'), positive and at most 1 USDT. */
export function sandboxAmount(v: unknown, fallback = DEFAULT_AMOUNT): bigint {
  const s = v === undefined || v === null || v === '' ? fallback : v;
  if (typeof s !== 'string' || !/^\d+(\.\d{1,6})?$/.test(s)) throw new BadRequest('amount must be a USDT decimal string like "0.25"');
  const n = parseUnits(s, 6);
  if (n === 0n) throw new BadRequest('amount must be positive');
  if (n > MAX_SANDBOX_AMOUNT) throw new SandboxRefused('sandbox amounts are capped at 1 USDT');
  return n;
}

const bytes32 = (v: unknown, name: string): Hex => {
  if (typeof v !== 'string' || !isHex(v) || size(v) !== 32) throw new BadRequest(`${name} must be a 32-byte hex`);
  return v;
};
const tokenIdOf = (v: unknown): bigint => {
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v)) return BigInt(v);
  throw new BadRequest('tokenId must be a decimal or hex string');
};

export function createSandbox(o: {
  config: SandboxConfig;
  ports: SandboxPorts;
  limiter?: RateLimiter;
  /** How long one /sandbox/admit call waits for the role to reach Whitechain before answering pending-sync. */
  syncBudgetMs?: number;
  syncPollMs?: number;
}) {
  const { config: c, ports: p } = o;
  const k = c.contracts;
  const limiter = o.limiter ?? createRateLimiter({ perDay: 20, perIpHour: 3, now: p.now });
  const syncBudgetMs = o.syncBudgetMs ?? 35_000; // the hosted function may run 60 s, and a proof takes a few seconds
  const syncPollMs = o.syncPollMs ?? 6_000;
  const signers = Object.fromEntries(Object.entries(c.keys).map(([w, key]) => [w, privateKeyToAccount(key)])) as Record<SandboxWho, ReturnType<typeof privateKeyToAccount>>;
  const sent = new Map<string, { tx: Hex; at: number }>();
  const inflight = new Map<string, Promise<AdmitResult>>();
  const recent: (ActionResult & { at: string })[] = [];
  let admitted = 0;

  const wc = <T>(to: Address, abi: Abi, fn: string, args?: readonly unknown[]) => p.read<T>('whitechain', to, abi, fn, args);
  const approverCache = new Map<string, Address>();
  /** Each sandbox person is an ApproverAccount whose only signer is their key's EOA. */
  const approverOf = async (who: SandboxWho): Promise<Address> => {
    const hit = approverCache.get(who);
    if (hit) return hit;
    const a = getAddress(await wc<Address>(k.approverFactory, factoryAbi, 'predictAddress', [[c.eoas[who]]]));
    approverCache.set(who, a);
    return a;
  };
  /** An ERC-1271 approval from `who`'s ApproverAccount over a module digest: abi.encode([eoa], [r||s||v]). */
  const approve = async (who: SandboxWho, digest: Hex) => ({
    approver: await approverOf(who),
    signature: encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[c.eoas[who]], [await signers[who].sign({ hash: digest })]]),
  });

  function record(r: ActionResult): ActionResult {
    recent.unshift({ ...r, at: new Date(p.now()).toISOString() });
    recent.length = Math.min(recent.length, 20);
    return r;
  }
  const decodeRevert = (r: SimResult): string => {
    if (r.ok) return '';
    if (r.data) {
      try {
        const d = decodeErrorResult({ abi: errorAbi, data: r.data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
      } catch { /* unknown error */ }
    }
    return r.error;
  };

  // ---- invoices (the app's own link format, via @tazor/pay)

  const today = () => new Date(p.now()).toISOString().slice(0, 10);
  const dueIn = (days: number) => new Date(p.now() + days * 86_400_000).toISOString().slice(0, 10);
  const newLink = (opts: { buyer: Address; payee: Address; supplierName: string; amount: bigint; description: string }) =>
    createInvoiceLink({
      supplierName: opts.supplierName, supplierAccount: opts.payee, payee: opts.payee, buyerAccount: opts.buyer,
      lines: [{ description: opts.description, unitPrice: usdt(opts.amount) }], dueDate: dueIn(14), appUrl: c.appUrl,
      id: `SBX-${today().replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`,
    });
  const authOf = (inv: Invoice, invoiceHash: Hex): InvoiceAuth => ({
    invoiceHash, account: getAddress(inv.buyerAccount), payee: getAddress(inv.payee), amount: inv.amount,
    expiry: BigInt(inv.dueDate) + AUTH_VALIDITY_AFTER_DUE, nonce: BigInt(invoiceHash),
  });
  const moduleFor = async (account: Address): Promise<Address> => {
    for (const m of [k.paymentModuleV2, k.paymentModuleV1]) {
      try {
        const reg = await wc<Address>(m, paymentV2Abi, 'registryOf', [account]);
        if (!isAddressEqual(reg, '0x0000000000000000000000000000000000000000')) return m;
      } catch { /* not configured here */ }
    }
    throw new SandboxRefused(`account ${account} has no PaymentModule configuration`);
  };
  const payOneData = (auth: InvoiceAuth, a: { approver: Address; signature: Hex }) =>
    encodeFunctionData({ abi: paymentV2Abi, functionName: 'payOne', args: [auth.account, auth, [a.approver], [a.signature]] });

  /** A sandbox-only invoice from a link: buyer is the sandbox company, payee is the sandbox supplier, at most 1 USDT. */
  async function sandboxInvoice(link: unknown): Promise<{ invoice: Invoice; auth: InvoiceAuth }> {
    if (typeof link !== 'string' || link.length > 8192) throw new BadRequest('link must be a Tazor payment link');
    let invoice: Invoice;
    try { invoice = await decodeInvoiceLink(link); } catch { throw new BadRequest('link is not a valid Tazor payment link'); }
    if (!isAddressEqual(invoice.buyerAccount, c.account)) throw new SandboxRefused('the sandbox only co-signs invoices to the sandbox company');
    if (!isAddressEqual(invoice.payee, c.supplier)) throw new SandboxRefused('the sandbox only co-signs payments to the sandbox supplier');
    if (invoice.amount > MAX_SANDBOX_AMOUNT) throw new SandboxRefused('sandbox amounts are capped at 1 USDT');
    if (!isAddressEqual(invoice.token, k.usdt)) throw new SandboxRefused('the sandbox only co-signs USDT invoices');
    return { invoice, auth: authOf(invoice, invoiceHash(invoice)) };
  }

  // ---- admission

  const stepTx = (name: Step['name'], chain: Net, tx: Hex | null, status: StepStatus, detail: string): Step =>
    ({ name, status, tx, chain, explorerUrl: txUrl(chain, tx), detail });
  /** A tx we sent for this step in the last 3 minutes, so a repeat call waits for it instead of sending again. */
  const recentSend = (key: string) => { const s = sent.get(key); return s && p.now() - s.at < 180_000 ? s.tx : null; };
  const remember = (key: string, tx: Hex) => { sent.set(key, { tx, at: p.now() }); return tx; };

  async function verifiedSoul(account: Address): Promise<{ soulId: bigint; verified: boolean; used: boolean }> {
    const soulId = await wc<bigint>(c.soulMirror, soulMirrorAbi, 'soulOf', [account]);
    const verified = soulId !== 0n && (await wc<Hex>(c.soulMirror, soulMirrorAbi, 'soulAttributeValue', [soulId, IS_VERIFIED_ATTRIBUTE])) !== '0x0000000000000000000000000000000000000000';
    const used = soulId !== 0n || (await wc<boolean>(c.soulMirror, soulMirrorAbi, 'isAddressUsed', [account]));
    return { soulId, verified, used };
  }
  const ensRoles = (account: Address) => p.read<bigint>('sepolia', c.registry, ensRegistryAbi, 'roles', [0n, account]);

  async function admitOnce(account: Address, signer: Hex | null, ip: string): Promise<AdmitInner> {
    if (signer) {
      const predicted = getAddress(await wc<Address>(k.approverFactory, factoryAbi, 'predictAddress', [[signer]]));
      if (!isAddressEqual(predicted, account)) throw new BadRequest(`approver is not the approver account of this signer (expected ${predicted})`);
    }
    if (Object.values(c.eoas).some((e) => isAddressEqual(e, account)) || isAddressEqual(account, c.account) || isAddressEqual(account, c.supplier)) {
      throw new SandboxRefused('that account belongs to the sandbox itself');
    }

    const [deployed, soul, roles] = await Promise.all([(async () => (await p.code(account)) !== '0x')(), verifiedSoul(account), ensRoles(account)]);
    const hasRole = (roles & ROLE_APPROVER) !== 0n;
    if (!deployed && !signer) throw new BadRequest('approver is not deployed yet: pass signer (its 20-byte EOA or 84-byte passkey id) or deploy it with POST /approver first');
    const firstVisit = !deployed || !soul.verified || !hasRole;
    if (firstVisit && !sent.has(`${account}:admitted`)) {
      const t = limiter.take(ip);
      if (!t.ok) throw new RateLimited(t.reason, t.retryAfterSec);
      sent.set(`${account}:admitted`, { tx: '0x', at: p.now() });
      admitted++;
    }

    const steps: Step[] = [];
    const fail = (s: Step): AdmitInner => ({ status: 'failed', account, registry: c.registry, steps: [...steps, s] });
    const attempt = async (name: Step['name'], chain: Net, from: From, to: Address, data: Hex, detail: string): Promise<Step> => {
      const key = `${account}:${name}`;
      const pending = recentSend(key);
      if (pending) return stepTx(name, chain, pending, 'pending', `${detail} (sent, waiting for inclusion)`);
      try {
        return stepTx(name, chain, remember(key, await p.send(chain, from, to, data)), 'done', detail);
      } catch (e) {
        const why = e instanceof SimulationFailed ? `simulation reverted: ${e.message}` : errorText(e);
        console.error(`sandbox ${name} (${chain}, ${from}) failed: ${why}`);
        return stepTx(name, chain, null, 'failed', `${detail} failed: ${why}`);
      }
    };

    // 1. the visitor's ApproverAccount (passkey signer) on Whitechain
    const deploy = deployed
      ? stepTx('deploy', 'whitechain', null, 'already', 'approver account already deployed')
      : await attempt('deploy', 'whitechain', p.hasRelayer ? 'relayer' : 'operator', k.approverFactory,
        encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [[signer!]] }), 'deployed the approver account');
    if (deploy.status === 'failed') return fail(deploy);
    steps.push(deploy);

    // 2. a new verified soul on the SIMULATED WB Soul mirror, via MirrorOperator's capped operator path
    let soulStep: Step;
    if (soul.verified) soulStep = stepTx('soul', 'whitechain', null, 'already', `soul #${soul.soulId} already verified (simulated WB Soul)`);
    else if (soul.used) soulStep = stepTx('soul', 'whitechain', null, 'failed', 'this address already has an unverified or revoked soul; the sandbox only verifies new souls');
    else soulStep = await attempt('soul', 'whitechain', 'operator', c.mirrorOperator,
      encodeFunctionData({ abi: mirrorOperatorAbi, functionName: 'registerVerified', args: [account] }), 'registered and verified a soul (simulated WB Soul)');
    if (soulStep.status === 'failed') return fail(soulStep);
    steps.push(soulStep);

    // 3. APPROVER on the sandbox company's ENS registry (Ethereum Sepolia)
    const role = hasRole
      ? stepTx('ens-role', 'sepolia', null, 'already', 'already an APPROVER on the sandbox company')
      : await attempt('ens-role', 'sepolia', 'operator', c.registry,
        encodeFunctionData({ abi: ensRegistryAbi, functionName: 'grantRootRoles', args: [ROLE_APPROVER, account] }), 'granted APPROVER on the sandbox company (ENS)');
    if (role.status === 'failed') return fail(role);
    steps.push(role);

    // 4. prove the ENS role onto Whitechain's RoleCache, waiting a bounded time for Whitechain to see the L1 block
    if (!p.sync) {
      steps.push(stepTx('sync', 'whitechain', null, 'skipped', 'role sync is not configured on this relayer'));
      return { status: 'pending-sync', account, registry: c.registry, steps };
    }
    // Only the RoleCache itself proves admission: a sync can be sent and still prove an L1 block from before the grant.
    const started = p.now();
    const key = `${account}:sync`;
    const earlier = recentSend(key);
    let lastTx: Hex | null = null;
    for (;;) {
      const [cachedRoles, cachedAt] = await wc<readonly [bigint, bigint]>(k.roleCache, roleCacheAbi, 'rolesOf', [c.registry, account]);
      if ((cachedRoles & ROLE_APPROVER) !== 0n) {
        steps.push(stepTx('sync', 'whitechain', lastTx ?? earlier, lastTx ? 'done' : 'already', `Whitechain's role cache holds APPROVER (proved at L1 block ${cachedAt})`));
        return { status: 'admitted', account, registry: c.registry, steps };
      }
      let r: SyncResult;
      try {
        r = await p.sync(c.registry, account);
      } catch (e) {
        console.error(`sandbox sync failed: ${errorText(e)}`);
        return fail(stepTx('sync', 'whitechain', lastTx ?? earlier, 'failed', `role sync failed: ${errorText(e)}`));
      }
      if (r.status === 'not-watched') return fail(stepTx('sync', 'whitechain', null, 'failed', 'the sandbox registry is not in WATCH_REGISTRIES'));
      if (r.status === 'synced' && r.tx) {
        lastTx = remember(key, r.tx);
        try {
          await p.wait('whitechain', r.tx);
        } catch (e) {
          return fail(stepTx('sync', 'whitechain', r.tx, 'failed', `role sync tx failed: ${errorText(e)}`));
        }
        // the proof may still predate the grant: re-read the cache now, else wait like any pending sync
        const [after] = await wc<readonly [bigint, bigint]>(k.roleCache, roleCacheAbi, 'rolesOf', [c.registry, account]);
        if ((after & ROLE_APPROVER) !== 0n) continue;
      }
      if (p.now() - started + syncPollMs > syncBudgetMs) {
        steps.push(stepTx('sync', 'whitechain', lastTx ?? earlier, 'pending', 'Whitechain cannot prove the ENS grant yet (it lags Ethereum by about a minute); call admit again'));
        return { status: 'pending-sync', account, registry: c.registry, steps };
      }
      await p.sleep(syncPollMs);
    }
  }

  /** Idempotent: each step checks chain state first; concurrent calls for one approver share one run. */
  function admit(body: unknown, ip: string): Promise<AdmitResult> {
    const b = (body ?? {}) as { approver?: unknown; account?: unknown; signer?: unknown };
    // `approver` is the guest's ApproverAccount; `account` is accepted as a legacy alias unless it is the sandbox company itself.
    const raw = typeof b.approver === 'string' ? b.approver
      : typeof b.account === 'string' && isAddress(b.account) && !isAddressEqual(b.account, c.account) ? b.account : undefined;
    if (typeof raw !== 'string' || !isAddress(raw)) throw new BadRequest('approver must be an address');
    if (typeof b.account === 'string' && typeof b.approver === 'string' && isAddress(b.account) && isAddress(b.approver)
      && !isAddressEqual(b.account, c.account) && !isAddressEqual(b.account, b.approver)) {
      throw new SandboxRefused('the sandbox only admits approvers to the sandbox company');
    }
    const signer = b.signer === undefined || b.signer === null || b.signer === '' ? null : b.signer;
    if (signer !== null && (typeof signer !== 'string' || !isHex(signer, { strict: true }) || ![20, 84].includes(size(signer)))) {
      throw new BadRequest('signer must be a 20-byte EOA or an 84-byte passkey id');
    }
    const approver = getAddress(raw);
    const running = inflight.get(approver);
    if (running) return running;
    const run = (async (): Promise<AdmitResult> => {
      if (signer && size(signer) === 84) {
        const verifier = await wc<Address>(k.approverFactory, factoryAbi, 'webAuthnVerifier');
        if (!isAddressEqual(slice(signer, 0, 20), verifier)) throw new BadRequest('passkey signer must use the factory WebAuthn verifier');
      }
      const r = await admitOnce(approver, signer as Hex | null, ip);
      const failed = r.steps.find((x) => x.status === 'failed');
      return {
        ok: r.status !== 'failed', status: r.status, companyId: c.companyId, approver, account: c.account, registry: c.registry,
        supplier: c.supplier, mandateAccount: c.account, txs: r.steps.flatMap((x) => (x.tx ? [x.tx] : [])), steps: r.steps,
        ...(failed ? { error: failed.detail } : {}),
      };
    })().finally(() => inflight.delete(approver));
    inflight.set(approver, run);
    return run;
  }

  // ---- counterparty actions (each signed by its sandbox key, only against the sandbox company)

  const send = async (action: Action, from: From, to: Address, data: Hex, detail: string, extra: Record<string, unknown> = {}): Promise<ActionResult> => {
    const tx = await p.send('whitechain', from, to, data);
    return { action, status: 'sent', tx, chain: 'whitechain', explorerUrl: txUrl('whitechain', tx), detail, ...extra };
  };
  const noTx = (action: Action, status: string, detail: string, extra: Record<string, unknown> = {}, url = addressUrl('whitechain', c.account)): ActionResult =>
    ({ action, status, tx: null, chain: 'whitechain', explorerUrl: url, detail, ...extra });

  const handlers: Record<Action, (params: Record<string, unknown>) => Promise<ActionResult>> = {
    async 'create-invoice'(q) {
      const amount = sandboxAmount(q.amount, '0.25');
      const description = typeof q.description === 'string' && q.description.trim() ? q.description.trim().slice(0, 80) : 'Sandbox consulting';
      const l = await newLink({ buyer: c.account, payee: c.supplier, supplierName: c.supplierName, amount, description });
      return noTx('create-invoice', 'created', `${c.supplierName} invoiced the sandbox company ${l.amount} USDT`,
        { link: l.url, invoice: { id: l.id, invoiceHash: l.invoiceHash, amount: l.amount, dueDate: l.invoice.dueDate } });
    },

    async 'approve-second'(q) {
      const links = Array.isArray(q.links) ? q.links : [q.link];
      if (links.length === 0 || links.length > 10) throw new BadRequest('pass link, or links (1..10)');
      const invoices = [];
      for (const l of links) invoices.push(await sandboxInvoice(l));
      const auths = invoices.map((i) => i.auth);
      const run = Array.isArray(q.links);
      const module = await moduleFor(c.account);
      const digest = run
        ? await wc<Hex>(module, paymentV2Abi, 'runDigest', [auths])
        : await wc<Hex>(module, paymentV2Abi, 'invoiceDigest', [auths[0]]);
      const approval = await approve('admin', digest);
      const total = auths.reduce((s, a) => s + a.amount, 0n);
      return noTx('approve-second', 'approved', `the sandbox admin co-signed ${run ? `a run of ${auths.length}` : 'the invoice'} (${usdt(total)} USDT) as the second approver`,
        { approval, digest, kind: run ? 'run' : 'invoice', paymentModule: module });
    },

    async 'revoke-ravi'() {
      const ravi = await approverOf('ravi');
      if (await wc<boolean>(k.revocationListV2, revocationV2Abi, 'isRevoked', [c.account, ravi])) {
        return noTx('revoke-ravi', 'already-revoked', 'Ravi is already revoked on the sandbox company', { ravi }, addressUrl('whitechain', k.revocationListV2));
      }
      const deadline = BigInt(Math.floor(p.now() / 1000) + 3600);
      const digest = await wc<Hex>(k.revocationListV2, revocationV2Abi, 'revokeDigest', [c.account, ravi, deadline]);
      const a = await approve('admin', digest);
      const r = await send('revoke-ravi', 'admin', k.revocationListV2,
        encodeFunctionData({ abi: revocationV2Abi, functionName: 'revoke', args: [c.account, ravi, a.approver, deadline, a.signature] }),
        'the sandbox admin revoked Ravi on Whitechain (instant, local)', { ravi });
      // answer only once mined, so an immediate ravi-pays already sees the revocation
      try {
        await p.wait('whitechain', r.tx!);
      } catch (e) {
        return { ...r, ok: false, status: 'failed', detail: `the revocation tx failed: ${errorText(e)}` };
      }
      return r;
    },

    async 'ravi-pays'(q) {
      const amount = sandboxAmount(q.amount);
      const ravi = await approverOf('ravi');
      const l = await newLink({ buyer: c.account, payee: c.supplier, supplierName: c.supplierName, amount, description: 'Sandbox: Ravi tries to pay' });
      const auth = authOf(l.invoice, l.invoiceHash);
      const module = await moduleFor(c.account);
      const digest = await wc<Hex>(module, paymentV2Abi, 'invoiceDigest', [auth]);
      const sim = await p.simulate('whitechain', 'operator', module, payOneData(auth, await approve('ravi', digest)));
      const revoked = await wc<boolean>(k.revocationListV2, revocationV2Abi, 'isRevoked', [c.account, ravi]);
      if (sim.ok) return noTx('ravi-pays', 'not-refused', 'the payment would have gone through, so nothing was sent; revoke Ravi first', { ravi, revoked, invoiceHash: l.invoiceHash });
      const why = decodeRevert(sim);
      // PaymentNotVerified covers unverified, revoked and expired approvers; name the cause when it's the revocation
      const detail = revoked && why.startsWith('PaymentNotVerified')
        ? "Whitechain refused Ravi's payment: Ravi was removed from the company (revocation list); contract error PaymentNotVerified"
        : `Whitechain refused Ravi's payment: ${why}`;
      return noTx('ravi-pays', 'refused', detail, { ravi, revoked, error: why, invoiceHash: l.invoiceHash });
    },

    async 'credit-note'(q) {
      const amount = sandboxAmount(q.amount);
      const l = await newLink({ buyer: c.supplier, payee: c.account, supplierName: 'Sandbox company (credit note)', amount, description: 'Credit note' });
      const auth = authOf(l.invoice, l.invoiceHash);
      const module = await moduleFor(c.supplier);
      const digest = await wc<Hex>(module, paymentV2Abi, 'invoiceDigest', [auth]);
      return send('credit-note', 'supplier', module, payOneData(auth, await approve('supplier', digest)),
        `${c.supplierName} paid a ${usdt(amount)} USDT credit note to the sandbox company`, { invoiceHash: l.invoiceHash, paymentModule: module });
    },

    async collect(q) {
      const mandateId = bytes32(q.mandateId, 'mandateId');
      const m = await wc<{ account: Address; payee: Address; cancelled: boolean }>(k.mandateModuleV2, mandateV2Abi, 'mandateOf', [mandateId]);
      if (!isAddressEqual(m.account, c.account)) throw new SandboxRefused('the sandbox only collects on mandates of the sandbox company');
      if (!isAddressEqual(m.payee, c.supplier)) throw new SandboxRefused('the sandbox only collects mandates payable to the sandbox supplier');
      if (m.cancelled) return noTx('collect', 'cancelled', 'that mandate was cancelled, so the supplier cannot pull');
      const available = await wc<bigint>(k.mandateModuleV2, mandateV2Abi, 'available', [mandateId]);
      const asked = sandboxAmount(q.amount);
      const amount = asked < available ? asked : available;
      if (amount === 0n) return noTx('collect', 'nothing-available', 'the mandate has no allowance left this period', { available: '0' });
      return send('collect', 'supplier', k.mandateModuleV2, encodeFunctionData({ abi: mandateV2Abi, functionName: 'pull', args: [mandateId, amount] }),
        `${c.supplierName} pulled ${usdt(amount)} USDT on the mandate`, { amount: usdt(amount), available: usdt(available) });
    },

    async 'finance-buy'(q) {
      const tokenId = tokenIdOf(q.tokenId);
      const [account, , claimAmount] = await wc<[Address, bigint, bigint]>(k.financingModule, financingAbi, 'claims', [tokenId]);
      if (!isAddressEqual(account, c.account)) throw new SandboxRefused('the sandbox financier only buys claims on the sandbox company');
      const price = await wc<bigint>(k.financingModule, financingAbi, 'listings', [tokenId]);
      if (price === 0n) return noTx('finance-buy', 'not-listed', 'that claim is not listed for sale');
      if (price > MAX_SANDBOX_AMOUNT) throw new SandboxRefused('the sandbox financier pays at most 1 USDT');
      const financier = c.eoas.financier;
      const allowance = await wc<bigint>(k.usdt, erc20Abi, 'allowance', [financier, k.financingModule]);
      const approveTx = allowance < price
        ? await p.send('whitechain', 'financier', k.usdt, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [k.financingModule, price] }))
        : null;
      return send('finance-buy', 'financier', k.financingModule, encodeFunctionData({ abi: financingAbi, functionName: 'buy', args: [tokenId] }),
        `the sandbox financier bought the claim for ${usdt(price)} USDT (face value ${usdt(claimAmount)})`,
        { approveTx, price: usdt(price), faceValue: usdt(claimAmount), financier });
    },

    async 'finance-settle'(q) {
      const tokenId = tokenIdOf(q.tokenId);
      const [account, dueDate, amount] = await wc<[Address, bigint, bigint]>(k.financingModule, financingAbi, 'claims', [tokenId]);
      if (!isAddressEqual(account, c.account)) throw new SandboxRefused('the sandbox only settles claims on the sandbox company');
      if (amount > MAX_SANDBOX_AMOUNT) throw new SandboxRefused('sandbox amounts are capped at 1 USDT');
      if (BigInt(Math.floor(p.now() / 1000)) < dueDate) {
        return noTx('finance-settle', 'not-due', `the claim is due ${new Date(Number(dueDate) * 1000).toISOString().slice(0, 10)}`, { dueDate: dueDate.toString() });
      }
      return send('finance-settle', 'financier', k.financingModule, encodeFunctionData({ abi: financingAbi, functionName: 'settle', args: [tokenId] }),
        `the sandbox company paid ${usdt(amount)} USDT to the claim's holder`, { amount: usdt(amount) });
    },
  };

  async function counterparty(body: unknown): Promise<ActionResult> {
    const b = (body ?? {}) as { action?: unknown; params?: unknown };
    if (typeof b.action !== 'string' || !(ACTIONS as readonly string[]).includes(b.action)) throw new BadRequest(`action must be one of ${ACTIONS.join(', ')}`);
    // params may be nested ({action, params}) or flat ({action, mandate, account, ...})
    const nested = typeof b.params === 'object' && b.params !== null ? (b.params as Record<string, unknown>) : {};
    const params: Record<string, unknown> = { ...(body as Record<string, unknown>), ...nested };
    if (typeof params.account === 'string' && (!isAddress(params.account) || !isAddressEqual(params.account, c.account))) {
      throw new SandboxRefused('the sandbox only acts on the sandbox company');
    }
    // empty strings (an id the client couldn't read) fall back to the setup's mandate and claim
    for (const k of ['mandateId', 'mandate', 'tokenId', 'claimId']) if (params[k] === '') delete params[k];
    params.mandateId ??= params.mandate ?? c.mandateId ?? undefined;
    params.tokenId ??= params.claimId ?? c.claimId ?? undefined;
    const r = await handlers[b.action as Action](params);
    const refused = r.status === 'refused' || r.status === 'not-refused';
    return record({ ok: r.status !== 'not-refused', ...r, ...(refused ? { reason: r.detail } : {}) });
  }

  /** Snapshot of the sandbox company for the Autopilot UI. Reads that fail come back as null. */
  async function status() {
    const safe = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
    const bal = (a: Address) => safe(async () => usdt(await wc<bigint>(k.usdt, erc20Abi, 'balanceOf', [a])));
    const people = Object.fromEntries(await Promise.all((['admin', 'ravi', 'supplier', 'financier'] as const).map(async (w) =>
      [w, { eoa: c.eoas[w], approver: await safe(() => approverOf(w)) }]))) as Record<string, { eoa: Address; approver: Address | null }>;
    const cfg = await safe(() => wc<Record<string, unknown>>(k.paymentModuleV2, paymentV2Abi, 'configV2Of', [c.account]));
    const windowLeft = await safe(() => wc<readonly [bigint, bigint]>(k.paymentModuleV2, paymentV2Abi, 'windowAvailable', [c.account]));
    const raviRevoked = people.ravi.approver ? await safe(() => wc<boolean>(k.revocationListV2, revocationV2Abi, 'isRevoked', [c.account, people.ravi.approver!])) : null;
    const amt = (v: unknown) => (typeof v === 'bigint' ? usdt(v) : null);
    return {
      enabled: true,
      company: { account: c.account, registry: c.registry, supplier: c.supplier, supplierName: c.supplierName, explorerUrl: addressUrl('whitechain', c.account) },
      people,
      balances: { account: await bal(c.account), supplier: await bal(c.supplier), financier: await bal(c.eoas.financier) },
      limits: cfg ? {
        perPayment: amt(cfg.perPaymentLimit), monthly: amt(cfg.monthlyLimit), twoApproverThreshold: amt(cfg.twoApproverThreshold),
        agentMonthlyCap: amt(cfg.agentMonthlyCap), monthlyAvailable: windowLeft ? usdt(windowLeft[0]) : null, agentAvailable: windowLeft ? usdt(windowLeft[1]) : null,
      } : null,
      raviRevoked,
      sandboxCaps: { maxAmount: usdt(MAX_SANDBOX_AMOUNT), admissionsPerDay: 20, admissionsPerIpHour: 3, admittedSinceStart: admitted },
      soulsRemainingToday: await safe(async () => (await wc<bigint>(c.mirrorOperator, mirrorOperatorAbi, 'remainingToday')).toString()),
      latest: recent,
    };
  }

  return { config: c, admit, counterparty, status };
}

export type Sandbox = ReturnType<typeof createSandbox>;
