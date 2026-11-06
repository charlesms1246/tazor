/**
 * Typed client for the relayer's Autopilot sandbox (POST /sandbox/admit, POST /sandbox/counterparty, GET /sandbox/status).
 * The sandbox is a public TESTNET company; its WB Soul verification is simulated. Every amount is capped at 1 USDT
 * and the relayer refuses any target that isn't the sandbox company.
 */
import { getRelayerUrl } from './relayer-url.ts';

export type SandboxChain = 'whitechain' | 'sepolia';
export type SandboxAction = 'create-invoice' | 'approve-second' | 'revoke-ravi' | 'ravi-pays' | 'credit-note' | 'collect' | 'finance-buy' | 'finance-settle';

export type SandboxStep = {
  name: 'deploy' | 'soul' | 'ens-role' | 'sync';
  status: 'done' | 'already' | 'pending' | 'skipped' | 'failed';
  tx: string | null; chain: SandboxChain; explorerUrl: string | null; detail: string;
};

/** POST /sandbox/admit. `approver` is the guest's ApproverAccount; `account` is the sandbox company it now approves for. */
export type SandboxAdmit = {
  ok: boolean;
  /** pending-sync: Whitechain hasn't seen the ENS role yet (~1 min lag); call admit again. */
  status: 'admitted' | 'pending-sync' | 'failed';
  companyId: string; approver: string; account: string; registry: string; supplier: string; mandateAccount: string;
  txs: string[]; steps: SandboxStep[]; error?: string;
};

/** Every /sandbox/counterparty answer. Extra fields per action are listed on SandboxActionExtras. */
export type SandboxActionResult = {
  ok: boolean; action: SandboxAction; status: string; tx: string | null; chain: SandboxChain; explorerUrl: string | null; detail: string;
  /** Set when status is 'refused' (ravi-pays) or 'not-refused'. */
  reason?: string;
} & Partial<SandboxActionExtras>;

export type SandboxActionExtras = {
  /** create-invoice: the payment link (open it on /pay). */
  link: string;
  invoice: { id: string; invoiceHash: string; amount: string; dueDate: number };
  /** approve-second: paste into the Pay page's approvals. */
  approval: { approver: string; signature: string };
  digest: string; kind: 'invoice' | 'run'; paymentModule: string;
  /** revoke-ravi / ravi-pays */
  ravi: string; revoked: boolean; error: string; invoiceHash: string;
  /** collect */
  amount: string; available: string;
  /** finance-buy */
  approveTx: string | null; price: string; faceValue: string; financier: string;
  /** finance-settle when not due */
  dueDate: string;
};

/** Errors (400 bad input, 403 not the sandbox / over the cap, 422 reverted, 429 rate limited, 502 upstream). */
export type SandboxError = {
  ok: false; status: 'failed' | 'refused'; error: string; reason: string; detail: string;
  tx: null; chain: SandboxChain; explorerUrl: null; retryAfterSec?: number;
};

export type SandboxStatus = {
  enabled: true;
  company: { account: string; registry: string; supplier: string; supplierName: string; explorerUrl: string };
  people: Record<'admin' | 'ravi' | 'supplier' | 'financier', { eoa: string; approver: string | null }>;
  /** USDT, decimal strings; null when a read failed. */
  balances: { account: string | null; supplier: string | null; financier: string | null };
  limits: { perPayment: string | null; monthly: string | null; twoApproverThreshold: string | null; agentMonthlyCap: string | null; monthlyAvailable: string | null; agentAvailable: string | null } | null;
  raviRevoked: boolean | null;
  sandboxCaps: { maxAmount: string; admissionsPerDay: number; admissionsPerIpHour: number; admittedSinceStart: number };
  soulsRemainingToday: string | null;
  latest: (SandboxActionResult & { at: string })[];
};

export type SandboxHealth = { enabled: boolean; account: string | null; registry: string | null };
export type SandboxResponse<T> = { httpStatus: number; body: T | SandboxError };

export const isSandboxError = <T>(b: T | SandboxError): b is SandboxError => (b as { ok?: unknown }).ok === false && 'error' in (b as object);

export function createSandboxClient(base: () => string = getRelayerUrl, f: typeof fetch = (...a) => globalThis.fetch(...a)) {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 90_000): Promise<SandboxResponse<T>> {
    const url = base().replace(/\/+$/, '');
    const fail = (error: string, httpStatus = 0): SandboxResponse<T> =>
      ({ httpStatus, body: { ok: false, status: 'failed', error, reason: error, detail: error, tx: null, chain: 'whitechain', explorerUrl: null } });
    if (!url) return fail('No relayer configured for the sandbox');
    try {
      const res = await f(`${url}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const j = (await res.json().catch(() => null)) as T | SandboxError | null;
      if (!j) return fail(`HTTP ${res.status}`, res.status);
      if (res.status === 404 && !isSandboxError(j)) return fail('this relayer has no sandbox', 404);
      return { httpStatus: res.status, body: j };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  return {
    /** Admits the guest's approver (pass `signer` if it isn't deployed yet). Idempotent; repeat on pending-sync. */
    admit: (approver: string, opts: { signer?: string } = {}) =>
      call<SandboxAdmit>('POST', '/sandbox/admit', { approver, ...(opts.signer ? { signer: opts.signer } : {}) }),
    /**
     * One counterparty action. Params by action:
     * create-invoice {amount?, description?} · approve-second {link} or {links} · revoke-ravi {} · ravi-pays {amount?} ·
     * credit-note {amount?} · collect {mandate?, amount?} · finance-buy {tokenId?} · finance-settle {tokenId?}.
     * Amounts are USDT decimal strings ≤ "1"; mandate/tokenId default to the setup's.
     */
    counterparty: (action: SandboxAction, params: Record<string, string | string[]> = {}) =>
      call<SandboxActionResult>('POST', '/sandbox/counterparty', { ...params, action }),
    status: () => call<SandboxStatus>('GET', '/sandbox/status', undefined, 20_000),
    /** The relayer's /health sandbox field, or null if unreachable. */
    async health(): Promise<SandboxHealth | null> {
      const r = await call<{ sandbox?: SandboxHealth }>('GET', '/health', undefined, 10_000);
      return isSandboxError(r.body) ? null : (r.body.sandbox ?? { enabled: false, account: null, registry: null });
    },
  };
}

export type SandboxClient = ReturnType<typeof createSandboxClient>;
export const sandbox: SandboxClient = createSandboxClient();
