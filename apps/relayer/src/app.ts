import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequest, encodePayOne, parsePayRequest } from './payment.ts';
import { SimulationFailed, type Sender } from './sender.ts';
import { parseSigner, type ApproverDeployer } from './approver.ts';
import { encodeRevoke, parseRevokeRequest } from './revoke.ts';
import { MANDATE_MODULE_V2, encodeCreateMandate, encodePull, findMandateModule, parseMandateRequest, parsePullRequest, pickByAccount, pickMandateModule } from './mandate.ts';
import { getAddress, isAddress, type PublicClient } from 'viem';
import type { RoleSync, ScanSummary, SyncResult } from './sync.ts';
import { PAYMENT_MODULE_V2, parsePayRunRequest, pickModule, preparePayRun } from './payrun.ts';
import { preparePayOne } from './pay-counterfactual.ts';
import { REVOCATION_LIST_V2, pickRevocationList } from './revoke-list.ts';
import { ENTRY_POINT_V08, RpcError, encodeHandleOps, parseUserOp, paymasterRpc } from './userop.ts';
import type { MirrorService } from './mirror-service.ts';
import type { Sandbox } from './sandbox/service.ts';
import { clientIp, handleSandbox } from './sandbox/routes.ts';
import { Paused, Throttled, type Guard, type GuardedRoute } from './guard.ts';
import type { Address } from 'viem';
import type { Checkout } from './checkout/service.ts';
import type { Deposit } from './checkout/deposit.ts';
import type { X402 } from './checkout/x402.ts';
import type { Webhooks } from './webhooks.ts';
import { CHECKOUT_ROUTES, WEBHOOK_ROUTES, X402_ROUTES, X402_NETWORKS, handleCheckout } from './checkout/routes.ts';

const MAX_BODY = 64 * 1024;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-payment',
  'access-control-expose-headers': 'x-payment-response',
};

/** JSON-safe view of a sync result (bigints as decimal strings). */
const syncJson = (r: SyncResult) => ({
  status: r.status, registry: r.registry, account: r.account,
  ...(r.tx ? { tx: r.tx } : {}), ...(r.roles !== undefined ? { roles: r.roles.toString() } : {}), ...(r.l1Block !== undefined ? { l1Block: r.l1Block.toString() } : {}),
});
const scanJson = (s: ScanSummary) => ({
  from: s.from.toString(), to: s.to.toString(), changes: s.changes, deferred: s.deferred,
  results: s.results.map((r) => ('error' in r ? r : syncJson(r))),
});

export const WATCH_LOOKBACK = 7200n;

async function mirrorHealthJson(m: MirrorService) {
  const h = await m.health();
  return { mirrorEnabled: h.mirrorEnabled, ...(h.reason ? { mirrorReason: h.reason } : {}), mirrorSender: h.sender, mirrorRegistries: h.authorized };
}
export const DOCS_URL = 'https://taz0r.eth.limo/docs/relayer-api/';

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BadRequest('body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BadRequest('invalid JSON'); }
}

export function createHandler(deps: {
  sender?: Sender; paymentModule?: `0x${string}`; approvers?: ApproverDeployer; revocationList?: `0x${string}`;
  mandateModule?: `0x${string}`; mandateModuleV2?: `0x${string}`; client?: PublicClient; paymentModuleV2?: `0x${string}`; revocationListV2?: `0x${string}`;
  paymaster?: `0x${string}`; chainId?: number;
  /** ENS → Whitechain role syncing (POST /sync, GET /watch); absent when no prover or sender is configured. */
  roleSync?: RoleSync;
  /** When set, GET /watch requires `authorization: Bearer <cronSecret>` (Vercel cron sends it). */
  cronSecret?: string;
  /** Whitechain revocation → ENS mirroring (POST /mirror and a pass in GET /watch). */
  mirror?: MirrorService;
  /** Autopilot sandbox (/sandbox/*); only when every SANDBOX_* variable is set. */
  sandbox?: Sandbox;
  /** Rate limits, the balance floor and the daily gas budget for every route that spends the relayer's gas. */
  guard?: Guard;
  /** Gasless checkout (TazorCheckout), the x402 facilitator and signed merchant webhooks. */
  checkout?: Checkout;
  deposit?: Deposit;
  x402?: X402;
  webhooks?: Webhooks;
  /** payTo of the demo x402 resource. */
  x402PayTo?: Address;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...headers }).end(JSON.stringify(body));
      console.log(`${req.method} ${req.url} ${status}`);
    };
    const guard = (route: GuardedRoute, account?: string) => deps.guard?.check(route, clientIp(req), account);
    try {
      if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
      const path = new URL(req.url ?? '/', 'http://relayer').pathname;
      if (req.method === 'GET' && path === '/') {
        return reply(200, { name: 'Tazor relayer', chainId: deps.chainId ?? 1874, relayer: deps.sender?.address ?? null, health: '/health', docs: DOCS_URL });
      }
      if (req.method === 'GET' && req.url === '/health') {
        return reply(200, {
          ok: true, relayer: deps.sender?.address ?? null, paymentModule: deps.paymentModule ?? null,
          approverAccountFactory: deps.approvers?.factory ?? null, revocationList: deps.revocationList ?? null,
          mandateModule: deps.mandateModule ?? null,
          roleSync: !!deps.roleSync, watchRegistries: deps.roleSync?.registries ?? deps.mirror?.registries ?? [],
          ...(deps.mirror ? await mirrorHealthJson(deps.mirror) : { mirrorEnabled: false, mirrorReason: 'mirror not configured' }),
          ...(deps.guard ? { gas: await deps.guard.health() } : {}),
          checkout: { enabled: !!deps.checkout, address: deps.checkout?.address ?? null, depositAddress: deps.deposit?.address ?? null, routes: CHECKOUT_ROUTES },
          x402: { enabled: !!deps.x402, networks: X402_NETWORKS, scheme: 'exact', asset: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', demoPayTo: deps.x402PayTo ?? null, routes: X402_ROUTES },
          webhooks: { enabled: !!deps.webhooks, merchants: deps.webhooks?.merchants() ?? 0, storage: deps.webhooks?.storage ?? null, routes: WEBHOOK_ROUTES },
          sandbox: { enabled: !!deps.sandbox, account: deps.sandbox?.config.account ?? null, registry: deps.sandbox?.config.registry ?? null },
        });
      }
      if (await handleCheckout(req, new URL(req.url ?? '/', 'http://relayer'), {
        checkout: deps.checkout, deposit: deps.deposit, x402: deps.x402, webhooks: deps.webhooks, guard: deps.guard, payTo: deps.x402PayTo,
      }, readJson, reply)) return;
      if (deps.sandbox && req.method === 'POST' && path === '/sandbox/admit') await guard('/sandbox/admit');
      if (deps.sandbox && (await handleSandbox(req, path, deps.sandbox, readJson, reply))) return;
      if (deps.mirror && req.method === 'POST' && path === '/mirror') {
        const body = (await readJson(req)) as { account?: unknown; target?: unknown } | null;
        const { account, target } = body ?? {};
        if (typeof account !== 'string' || !isAddress(account) || typeof target !== 'string' || !isAddress(target)) {
          throw new BadRequest('account and target must be addresses');
        }
        const h = await deps.mirror.health();
        const r = await deps.mirror.mirrorOne(getAddress(account), getAddress(target));
        return reply(200, { ...r, ...(r.status === 'not-authorized' && h.reason ? { reason: h.reason } : {}) });
      }
      if (deps.roleSync && req.method === 'POST' && path === '/sync') {
        const body = (await readJson(req)) as { registry?: unknown; account?: unknown } | null;
        const { registry, account } = body ?? {};
        if (typeof registry !== 'string' || !isAddress(registry) || typeof account !== 'string' || !isAddress(account)) {
          throw new BadRequest('registry and account must be addresses');
        }
        await guard('/sync', account);
        return reply(200, syncJson(await deps.roleSync.syncAccount(getAddress(registry), getAddress(account))));
      }
      if ((deps.roleSync || deps.mirror || deps.checkout) && req.method === 'GET' && path === '/watch') {
        if (deps.cronSecret && req.headers.authorization !== `Bearer ${deps.cronSecret}`) return reply(401, { error: 'unauthorized' });
        const roles = deps.roleSync ? scanJson(await deps.roleSync.scanOnce({ lookback: WATCH_LOOKBACK })) : {};
        const mirror = deps.mirror ? await deps.mirror.scanOnce() : undefined;
        // subscriptions: charge the due ones (within the gas budget), remind merchants 24 h ahead
        const subscriptions = deps.checkout ? await deps.checkout.scanDue(async () => { await deps.guard?.checkBudget(); }).catch((e) => ({ error: e instanceof Error ? e.message.split('\n')[0] : String(e) })) : undefined;
        return reply(200, { ...roles, ...(mirror ? { mirror } : {}), ...(subscriptions ? { subscriptions } : {}) });
      }
      if (req.method === 'POST' && (req.url === '/mandate' || req.url === '/pull')) {
        const json = await readJson(req);
        const create = req.url === '/mandate' ? parseMandateRequest(json) : null;
        const pull = create ? null : parsePullRequest(json);
        const data = create ? encodeCreateMandate(create) : encodePull(pull!);
        // v2 companies use MandateModuleV2: by account for /mandate, by where the mandate id lives for /pull
        const mods = { v1: deps.mandateModule, v2: deps.mandateModuleV2 ?? MANDATE_MODULE_V2, paymentModuleV2: deps.paymentModuleV2 ?? PAYMENT_MODULE_V2 };
        const to = !deps.client || !mods.v1 ? mods.v1
          : create ? await pickMandateModule(deps.client, create.mandate.account, { ...mods, v1: mods.v1 })
          : await findMandateModule(deps.client, pull!.mandateId, { v1: mods.v1, v2: mods.v2 });
        if (!deps.sender || !to) return reply(503, { error: 'relayer not configured', to: to ?? null, data });
        await guard(create ? '/mandate' : '/pull', create ? create.mandate.account : pull!.mandateId);
        return reply(200, { txHash: await deps.sender.send(to, data), mandateModule: to });
      }
      if (req.method === 'POST' && req.url === '/revoke') {
        const json = await readJson(req);
        const data = encodeRevoke(parseRevokeRequest(json));
        const listV2 = deps.revocationListV2 ?? REVOCATION_LIST_V2;
        const named = (json as { list?: unknown } | null)?.list;
        // no explicit list: a v2 company revokes on RevocationListV2 (same rule as the mandate module)
        const byAccount = (named === undefined || named === null) && deps.client && deps.revocationList
          ? ((await pickByAccount(deps.client, parseRevokeRequest(json).account, { v1: deps.revocationList, v2: listV2, paymentModuleV2: deps.paymentModuleV2 ?? PAYMENT_MODULE_V2 })))
          : undefined;
        const list = byAccount ?? pickRevocationList(json, deps.revocationList, listV2);
        if (!deps.sender || !list) return reply(503, { error: 'relayer not configured', to: list ?? null, data });
        await guard('/revoke', parseRevokeRequest(json).account);
        return reply(200, { txHash: await deps.sender.send(list, data) });
      }
      if (req.method === 'POST' && req.url === '/approver') {
        const a = deps.approvers;
        if (!a) return reply(503, { error: 'approver factory not configured' });
        const signer = parseSigner(await readJson(req), await a.webAuthnVerifier());
        const account = await a.predict(signer);
        if (await a.isDeployed(account)) return reply(200, { account, txHash: null });
        if (!deps.sender) return reply(503, { error: 'relayer not configured', account });
        await guard('/approver', signer);
        return reply(200, { account, txHash: await deps.sender.send(a.factory, a.createCalldata(signer)) });
      }
      if (req.method === 'POST' && (req.url === '/pay' || req.url === '/pay/calldata')) {
        const parsed = parsePayRequest(await readJson(req));
        const data = encodePayOne(parsed);
        if (req.url === '/pay/calldata') {
          // the module this account actually uses (v2 companies: PaymentModuleV2; same payOne calldata)
          const to = deps.client && deps.paymentModule
            ? await pickModule(deps.client, parsed.account, deps.paymentModule, deps.paymentModuleV2 ?? PAYMENT_MODULE_V2).catch(() => deps.paymentModule!)
            : deps.paymentModule ?? null;
          return reply(200, { to, data });
        }
        if (!deps.sender || !deps.paymentModule) return reply(503, { error: 'relayer not configured; submit /pay/calldata yourself' });
        await guard('/pay', parsed.account);
        if (!deps.client || !deps.approvers) return reply(200, { txHash: await deps.sender.send(deps.paymentModule, data) });
        // a v2 company pays through PaymentModuleV2 (same payOne signature, its own invoice digest and policy checks)
        const to = await pickModule(deps.client, parsed.account, deps.paymentModule, deps.paymentModuleV2 ?? PAYMENT_MODULE_V2);
        const p = await preparePayOne(deps.client, deps.approvers.factory, to, parsed);
        const deployTxs = [];
        for (const d of p.deploys) deployTxs.push(await deps.sender.send(d.to, d.data));
        return reply(200, { txHash: await deps.sender.send(to, p.data), paymentModule: to, deployTxs });
      }
      if (req.method === 'POST' && req.url === '/payrun') {
        const parsed = parsePayRunRequest(await readJson(req));
        if (!deps.sender || !deps.paymentModule || !deps.client || !deps.approvers) return reply(503, { error: 'relayer not configured; use Copy calldata' });
        await guard('/payrun', parsed.account);
        const p = await preparePayRun(deps.client, deps.approvers.factory, deps.paymentModule, deps.paymentModuleV2 ?? PAYMENT_MODULE_V2, parsed);
        const deployTxs = [];
        for (const d of p.deploys) deployTxs.push(await deps.sender.send(d.to, d.data));
        return reply(200, { txHash: await deps.sender.send(p.to, p.data), paymentModule: p.to, deployTxs });
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        const body = (await readJson(req)) as { id?: unknown; method?: unknown; params?: unknown } | null;
        const id = body?.id ?? null;
        try {
          const result = await paymasterRpc(String(body?.method), body?.params, { paymaster: deps.paymaster, chainId: deps.chainId ?? 1874, client: deps.client });
          return reply(200, { jsonrpc: '2.0', id, result });
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          return reply(200, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
        }
      }
      if (req.method === 'POST' && req.url === '/userop') {
        const body = (await readJson(req)) as { userOp?: unknown } | null;
        const op = parseUserOp(body?.userOp, { requireSignature: true });
        if (!deps.sender) return reply(503, { error: 'relayer not configured' });
        await guard('/userop', op.sender);
        return reply(200, { txHash: await deps.sender.send(ENTRY_POINT_V08, encodeHandleOps(op, deps.sender.address)) });
      }
      return reply(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BadRequest) return reply(400, { error: e.message });
      if (e instanceof Throttled) return reply(429, { error: e.message, retryAfterSec: e.retryAfterSec }, { 'retry-after': String(e.retryAfterSec) });
      if (e instanceof Paused) return reply(503, { error: e.message, paused: true });
      if (e instanceof SimulationFailed) return reply(422, { error: `simulation reverted: ${e.message}` });
      return reply(502, { error: 'upstream error' });
    }
  };
}
