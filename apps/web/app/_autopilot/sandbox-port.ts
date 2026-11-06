/**
 * What the Autopilot needs from the sandbox service (POST /sandbox/admit and /sandbox/counterparty).
 * The default talks to the relayer over fetch and reads the response loosely; when lib/sandbox.ts lands,
 * pass its client to setSandbox() and nothing else changes.
 */
import type { ApiResult, Chain, Ctx } from './engine.ts';

export type CounterpartyAction = 'create-invoice' | 'approve-second' | 'revoke-ravi' | 'ravi-pays' | 'credit-note' | 'collect' | 'finance-buy' | 'finance-settle';

export interface SandboxPort {
  /** Admits the guest's approver account to the sandbox company; data carries the company the guest now acts for. */
  admit(approver: string): Promise<ApiResult>;
  counterparty(action: CounterpartyAction, args: Record<string, string>): Promise<ApiResult>;
}

type Raw = { ok?: boolean; status?: string; tx?: string; txHash?: string; txs?: string[]; hash?: string; chain?: string; detail?: string; message?: string; reason?: string; error?: string; [k: string]: unknown };

const pickData = (r: Raw): Ctx => {
  const out: Ctx = {};
  const company = (r.company ?? {}) as Record<string, unknown>;
  const set = (k: string, v: unknown) => { if (typeof v === 'string' && v) out[k] = v; };
  const supplier = (r.supplier ?? company.supplier ?? {}) as Record<string, unknown> | string;
  set('buyerCompany', r.companyId ?? company.id ?? company.label);
  set('buyerAccount', r.account ?? company.account);
  set('mandateAccount', r.mandateAccount ?? company.mandateAccount ?? r.account ?? company.account);
  set('registry', r.registry ?? company.registry);
  set('supplierAccount', r.supplierAccount ?? company.supplierAccount ?? (typeof supplier === 'string' ? supplier : supplier.account));
  set('link', r.link);
  return out;
};

/** Normalises any of the likely response shapes into an ApiResult. */
export function toResult(status: number, r: Raw | null): ApiResult {
  const body = r ?? {};
  const tx = body.tx ?? body.txHash ?? body.hash;
  const refused = body.status === 'refused' || body.status === 'reverted';
  const ok = status >= 200 && status < 300 && body.ok !== false && !body.error && !refused;
  return {
    ok,
    ...(typeof tx === 'string' ? { tx } : {}),
    ...(Array.isArray(body.txs) ? { txs: body.txs.filter((t): t is string => typeof t === 'string') } : {}),
    ...(body.chain === 'sepolia' || body.chain === 'whitechain' ? { chain: body.chain as Chain } : {}),
    ...(typeof (body.detail ?? body.message) === 'string' ? { detail: String(body.detail ?? body.message) } : {}),
    ...(!ok ? { error: String(body.reason ?? body.error ?? body.detail ?? `HTTP ${status}`) } : {}),
    data: pickData(body),
  };
}

export function fetchSandbox(base: () => string, f: typeof fetch = (...a) => globalThis.fetch(...a)): SandboxPort {
  const post = async (path: string, body: unknown): Promise<ApiResult> => {
    const url = base().replace(/\/+$/, '');
    if (!url) return { ok: false, error: 'No relayer configured for the sandbox' };
    try {
      const res = await f(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      const j = (await res.json().catch(() => null)) as Raw | null;
      return toResult(res.status, j);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    admit: (approver) => post('/sandbox/admit', { approver, account: approver }),
    counterparty: (action, args) => post('/sandbox/counterparty', { ...args, action }),
  };
}

let port: SandboxPort | null = null;
export const setSandbox = (p: SandboxPort) => { port = p; };
export const getSandbox = (fallback: () => SandboxPort) => (port ??= fallback());
