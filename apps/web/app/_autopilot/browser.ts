'use client';

/** Browser bindings for the Autopilot engine: the real DOM, navigation, storage, RPC receipts and the sandbox. */
import { setCompany } from '../../lib/company.ts';
import { createSandboxClient, isSandboxError } from '../../lib/sandbox.ts';
import { config } from '../../lib/config.ts';
import { getRelayerUrl } from '../../lib/relayer-url.ts';
import { loadPasskey } from '../../lib/storage.ts';
import { createRunner, KEY, parseState, type ApiResult, type Chain, type Ctx, type Deps, type Dom, type RunState, type Runner } from './engine.ts';
import { fromClient, getSandbox, type CounterpartyAction } from './sandbox-port.ts';
import { LABELS, STORY } from './story.ts';

export const AUTOPILOT_EVENT = 'tazor:autopilot';
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
export function findTestId(testid: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-testid="${CSS.escape(testid)}"]`)];
  return all.find(visible) ?? null;
}

/** Sets a React-controlled field the way typing would. */
function setValue(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export const browserDom: Dom = {
  path: () => location.pathname,
  exists: (t) => !!findTestId(t),
  enabled: (t) => { const el = findTestId(t); return !!el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true'; },
  text: (t) => findTestId(t)?.innerText ?? null,
  attr: (t, name, inner) => { const el = findTestId(t); const x = inner ? el?.querySelector(inner) : el; return x?.getAttribute(name) ?? null; },
  hasText: (text) => document.body.innerText.includes(text),
  click: (t) => { const el = findTestId(t); el?.scrollIntoView({ block: 'center' }); el?.click(); },
  fill: (t, v) => { const el = findTestId(t); if (!el) throw new Error(`no field "${t}"`); el.scrollIntoView({ block: 'center' }); el.focus(); setValue(el, v); },
};

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

async function receipt(chain: Chain, hash: string): Promise<'ok' | 'reverted' | null> {
  try {
    const r = await rpc<{ status: string } | null>(chain === 'sepolia' ? config.sepolia.rpcUrl : config.rpcUrl, 'eth_getTransactionReceipt', [hash]);
    return r ? (r.status === '0x1' ? 'ok' : 'reverted') : null;
  } catch {
    return null;
  }
}

const client = createSandboxClient(() => process.env.NEXT_PUBLIC_SANDBOX_URL || getRelayerUrl());
async function receiptLogs(chain: Chain, hash: string): Promise<{ address: string; topics: string[] }[] | null> {
  try {
    const r = await rpc<{ logs: { address: string; topics: string[] }[] } | null>(chain === 'sepolia' ? config.sepolia.rpcUrl : config.rpcUrl, 'eth_getTransactionReceipt', [hash]);
    return r ? r.logs : null;
  } catch {
    return null;
  }
}

const sandbox = () => getSandbox(() => fromClient(client));

/** The sandbox supplier's display name, from GET /sandbox/status. */
async function supplierName(): Promise<string> {
  const r = await client.status();
  return !isSandboxError(r.body) && r.body.company?.supplierName ? r.body.company.supplierName : 'Sandbox Supplier';
}

async function api(name: string, args: Record<string, string>): Promise<ApiResult> {
  if (name === 'preflight') {
    const p = loadPasskey();
    if (!p) return { ok: false, error: 'No passkey on this device yet. Choose "Try it yourself" to create one.' };
    return { ok: true, detail: `Passkey found: approver ${p.approverAccount.slice(0, 6)}…${p.approverAccount.slice(-4)}`, data: { approver: p.approverAccount } };
  }
  if (name === 'sandbox-admit') {
    const r = await sandbox().admit(args.approver);
    if (!r.ok || r.status === 'pending-sync') return r;   // the engine repeats admit while it is pending-sync
    const data: Ctx = { buyerCompany: 'sandbox', ...r.data };
    if (!data.mandateAccount && data.buyerAccount) data.mandateAccount = data.buyerAccount;
    const missing = (['buyerAccount', 'registry', 'supplierAccount'] as const).filter((k) => !ADDR.test(data[k] ?? ''));
    if (missing.length) return { ok: false, error: `The sandbox did not return the ${missing.join(', ')}` };
    data.supplierName = await supplierName();
    return { ...r, detail: `You approve for the sandbox company ${data.buyerAccount.slice(0, 6)}…${data.buyerAccount.slice(-4)}; its supplier is ${data.supplierName}`, data };
  }
  if (name === 'counterparty') {
    const { action, ...rest } = args;
    return sandbox().counterparty(action as CounterpartyAction, rest);
  }
  if (name === 'sync') {
    const base = getRelayerUrl();
    if (!base) return { ok: false, error: 'No relayer configured' };
    try {
      const res = await fetch(`${base}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ registry: args.registry, account: args.account }), signal: AbortSignal.timeout(60_000) });
      const j = await res.json();
      if (!res.ok) return { ok: false, error: j.error ?? `relayer returned ${res.status}` };
      const words: Record<string, string> = { synced: 'Role proven onto Whitechain', 'in-sync': 'Already in sync: Whitechain matches ENS', 'pending-l1': 'ENS changed a moment ago; Whitechain can prove it in about a minute', 'not-watched': 'This relayer does not sync this company' };
      return { ok: j.status !== 'not-watched', tx: j.tx, detail: words[j.status] ?? j.status, ...(j.status === 'not-watched' ? { error: words[j.status] } : {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, error: `unknown call ${name}` };
}

function navigate(url: string): boolean {
  const next = new URL(url, location.href);
  const samePage = next.origin === location.origin && next.pathname === location.pathname && next.search === location.search;
  if (samePage && next.hash !== location.hash) { location.hash = next.hash; return false; }
  location.assign(next.href);
  return true;
}

const deps: Omit<Deps, 'onChange'> = {
  dom: browserDom,
  navigate,
  setCompany: (id) => setCompany(id as never),
  api: (n, a) => api(n, a),
  receipt,
  receiptLogs,
  save: (s) => { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ } },
  load: () => { try { return parseState(localStorage.getItem(KEY)); } catch { return null; } },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  label: (t) => LABELS[t] ?? 'the next control',
};

let runner: Runner | null = null;
/** One runner per page load, shared by the panel and the /autopilot page. */
export function getRunner(): Runner {
  runner ??= createRunner(STORY, { ...deps, onChange: (s: RunState | null) => globalThis.dispatchEvent(new CustomEvent(AUTOPILOT_EVENT, { detail: s })) });
  return runner;
}

export const explorerTx = (chain: Chain | undefined, tx: string) => (chain === 'sepolia' ? `${config.sepolia.explorer}/tx/${tx}` : `${config.explorer}/tx/${tx}`);
