import { useEffect, useMemo, useState } from 'react';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, toHex, type Address, type Hex } from 'viem';
import { config } from './config.ts';
import { configV2 } from './config-v2.ts';
import { companyByAccount } from './company.ts';
import { eventsFor, EVENTS_CHANGED, recentEvents, type TimelineEvent } from './events.ts';
import { loadInbox } from './inbox.ts';
import { loadInvoices } from './invoices-store.ts';
import { decodeConfigV2, encodeConfigV2Of, ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN } from './policies.ts';
import { ethCall } from './rpc.ts';
import { loadPayments } from './storage.ts';
import { invoiceHash } from './invoice.ts';

/** Event fragments, copied from contracts/src (PaymentModule(V2), MandateModule(V2), RevocationList, RoleCache, EnsGate). */
export const historyAbi = parseAbi([
  'event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1)',
  'event AgentPaid(address indexed account, uint256 indexed nonce, address indexed agent)',
  'event ProvisionalGranted(address indexed account, address indexed grantee, uint256 roles, uint64 validUntil)',
  'event MandateCreated(bytes32 indexed mandateId, address indexed account, address indexed payee, uint256 capPerPeriod, uint64 period, uint64 expiry)',
  'event MandatePulled(bytes32 indexed mandateId, uint256 amount, uint256 periodIndex)',
  'event MandateCancelled(bytes32 indexed mandateId, address by)',
  'event ApproverRevoked(address indexed account, address indexed target, address indexed admin)',
  'event RolesSynced(address indexed registry, address indexed account, uint256 roles, uint64 l1Block)',
  'event Forwarded(string label, address indexed account, uint256 indexed nonce)',
]);

/** One log as returned by Blockscout v2 /api/v2/addresses/<contract>/logs (only the fields used). */
export type BlockscoutLog = {
  block_number: number;
  block_timestamp: string;
  data: Hex;
  topics: (Hex | null)[];
  transaction_hash: Hex;
  index: number;
};

export type Source = { name: string; contract: Address; chain: 'whitechain' | 'sepolia'; api: string };

/** An event read from the chain: a TimelineEvent plus what Approvals ▸ Paid needs. */
export type ChainEvent = TimelineEvent & {
  source: 'chain';
  block: number;
  logIndex: number;
  payer?: Address;
  payee?: Address;
  amount?: string;
};

export const WC_API = 'https://explorer.testnet.whitechain.io/api/v2';
export const SEPOLIA_API = 'https://eth-sepolia.blockscout.com/api/v2';
const MAX_PAGES = 3;

/** Contracts whose logs make up a company's history (unset addresses are skipped). */
export function historySources(): Source[] {
  const list: [string, Address | null, 'whitechain' | 'sepolia'][] = [
    ['PaymentModule', config.paymentModule, 'whitechain'],
    ['PaymentModuleV2', configV2.paymentModule, 'whitechain'],
    ['MandateModule', config.mandateModule, 'whitechain'],
    ['MandateModuleV2', configV2.mandateModule, 'whitechain'],
    ['RevocationList', config.revocationList, 'whitechain'],
    ['RevocationListV2', configV2.revocationList, 'whitechain'],
    ['RoleCache', config.roleCache, 'whitechain'],
    ['EnsGate', config.sepolia.ensGate, 'sepolia'],
    ['EnsGateV2', configV2.ensGateV2, 'sepolia'],
  ];
  return list.flatMap(([name, contract, chain]) => (contract ? [{ name, contract, chain, api: chain === 'sepolia' ? SEPOLIA_API : WC_API }] : []));
}

/** Up to 3 pages of a contract's logs, newest first. */
export async function fetchLogs(src: Source, f: typeof fetch = fetch, maxPages = MAX_PAGES): Promise<BlockscoutLog[]> {
  const out: BlockscoutLog[] = [];
  let query = '';
  for (let page = 0; page < maxPages; page++) {
    const res = await f(`${src.api}/addresses/${src.contract}/logs${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${src.name} logs: explorer returned ${res.status}`);
    const body = (await res.json()) as { items?: BlockscoutLog[]; next_page_params?: Record<string, unknown> | null };
    out.push(...(body.items ?? []));
    if (!body.next_page_params) break;
    query = `?${new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]))}`;
  }
  return out;
}

// ---- mapping

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const name = (a: string) => companyByAccount(a)?.name ?? short(a);
const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const ON_CHAIN = 'on-chain';
const roleNames = (r: bigint) =>
  [r & ROLE_APPROVER ? 'approver' : '', r & ROLE_TAZOR_ADMIN ? 'admin' : '', r & ROLE_AGENT ? 'agent' : ''].filter(Boolean).join(', ') || 'no roles';

/** Names for invoice hashes this device knows (created here, paid here, or opened here). */
export type InvoiceNames = (hash: string) => string | null;
export function localInvoiceNames(): InvoiceNames {
  const m = new Map<string, string>();
  try { for (const s of loadInvoices()) m.set(invoiceHash(s.invoice).toLowerCase(), s.invoice.id); } catch { /* none */ }
  try { for (const p of loadPayments()) m.set(invoiceHash(p.invoice).toLowerCase(), p.invoice.id); } catch { /* none */ }
  try { for (const i of loadInbox()) if (i.kind === 'invoice') m.set(i.id.toLowerCase(), i.title.replace(/^Invoice /, '')); } catch { /* none */ }
  return (h) => m.get(h.toLowerCase()) ?? null;
}

export type MapContext = { account: Address; registries?: Address[]; names?: InvoiceNames };

/** Turns raw logs into this company's events: only logs that involve the account (or its ENS registry for role syncs). */
export function mapLogs(batches: { src: Source; logs: BlockscoutLog[] }[], ctx: MapContext): ChainEvent[] {
  const A = ctx.account;
  const names = ctx.names ?? (() => null);
  const invoiceLabel = (subject: string) => names(subject) ?? `Invoice ${short(subject)}`;
  const decoded = batches.flatMap(({ src, logs }) => logs.flatMap((log) => {
    try {
      const topics = log.topics.filter((t): t is Hex => !!t);
      const ev = decodeEventLog({ abi: historyAbi, data: log.data, topics: topics as [Hex, ...Hex[]] });
      return [{ src, log, ev }];
    } catch {
      return [];
    }
  }));

  // per-tx context: how many invoices a payment run paid, and which were paid by an agent
  const paidPerTx = new Map<string, number>();
  const agentOf = new Map<string, Address>();
  const myMandates = new Set<string>();
  for (const { log, ev } of decoded) {
    if (ev.eventName === 'InvoicePaid') paidPerTx.set(log.transaction_hash, (paidPerTx.get(log.transaction_hash) ?? 0) + 1);
    if (ev.eventName === 'AgentPaid') agentOf.set(`${log.transaction_hash}:${ev.args.nonce}`, ev.args.agent);
    if (ev.eventName === 'MandateCreated' && (eq(ev.args.account, A) || eq(ev.args.payee, A))) myMandates.add(ev.args.mandateId.toLowerCase());
  }

  const out: ChainEvent[] = [];
  for (const { src, log, ev } of decoded) {
    const base = {
      source: 'chain' as const, at: Date.parse(log.block_timestamp), tx: log.transaction_hash, chain: src.chain,
      block: log.block_number, logIndex: log.index,
    };
    switch (ev.eventName) {
      case 'InvoicePaid': {
        const { account, nonce, payee, amount, viaL1 } = ev.args;
        if (!eq(account, A) && !eq(payee, A)) break;
        const subject = toHex(nonce, { size: 32 });
        const run = paidPerTx.get(log.transaction_hash) ?? 1;
        const agent = agentOf.get(`${log.transaction_hash}:${nonce}`);
        out.push({
          ...base, subject, kind: 'paid',
          title: `${invoiceLabel(subject)} paid: ${usdt(amount)} from ${name(account)} to ${name(payee)}${run > 1 ? ` in a payment run (${run} invoices)` : ''}`,
          actor: agent ? `agent ${short(agent)}` : undefined,
          detail: [ON_CHAIN, viaL1 ? 'delivered via Ethereum' : null, src.name].filter(Boolean).join(' · '),
          payer: account, payee, amount: amount.toString(),
        });
        break;
      }
      case 'ProvisionalGranted': {
        const { account, grantee, roles, validUntil } = ev.args;
        if (!eq(account, A)) break;
        out.push({
          ...base, subject: grantee.toLowerCase(), kind: 'role-granted',
          title: `${short(grantee)} granted provisional ${roleNames(roles)} at ${name(account)}`,
          detail: `${ON_CHAIN} · until ${new Date(Number(validUntil) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        });
        break;
      }
      case 'MandateCreated': {
        const { mandateId, account, payee, capPerPeriod, period } = ev.args;
        if (!myMandates.has(mandateId.toLowerCase())) break;
        out.push({
          ...base, subject: mandateId.toLowerCase(), kind: 'mandate-created',
          title: `Mandate ${short(mandateId)} set up: ${name(account)} pays ${name(payee)} up to ${usdt(capPerPeriod)} every ${Number(period) / 86400} days`,
          detail: `${ON_CHAIN} · ${src.name}`, payer: account, payee,
        });
        break;
      }
      case 'MandatePulled': {
        const { mandateId, amount, periodIndex } = ev.args;
        if (!myMandates.has(mandateId.toLowerCase())) break;
        out.push({
          ...base, subject: mandateId.toLowerCase(), kind: 'collected',
          title: `Mandate ${short(mandateId)} collected ${usdt(amount)}`, detail: `${ON_CHAIN} · period ${periodIndex}`, amount: amount.toString(),
        });
        break;
      }
      case 'MandateCancelled': {
        const { mandateId, by } = ev.args;
        if (!myMandates.has(mandateId.toLowerCase())) break;
        out.push({ ...base, subject: mandateId.toLowerCase(), kind: 'mandate-cancelled', title: `Mandate ${short(mandateId)} cancelled by ${name(by)}`, detail: ON_CHAIN });
        break;
      }
      case 'ApproverRevoked': {
        const { account, target, admin } = ev.args;
        if (!eq(account, A)) break;
        out.push({
          ...base, subject: target.toLowerCase(), kind: 'role-revoked',
          title: `${short(target)} revoked as an approver of ${name(account)}`, actor: short(admin), detail: `${ON_CHAIN} · ${src.name}`,
        });
        break;
      }
      case 'RolesSynced': {
        const { registry, account, roles, l1Block } = ev.args;
        if (!ctx.registries?.some((r) => eq(r, registry))) break;
        out.push({
          ...base, subject: account.toLowerCase(), kind: 'role-synced',
          title: `Roles of ${short(account)} synced from ENS: ${roleNames(roles)}`, detail: `${ON_CHAIN} · Ethereum block ${l1Block}`,
        });
        break;
      }
      case 'Forwarded': {
        const { label, account, nonce } = ev.args;
        if (!eq(account, A)) break;
        const subject = toHex(nonce, { size: 32 });
        out.push({
          ...base, subject, kind: 'fallback-sent',
          title: `${invoiceLabel(subject)} sent via Ethereum (${label}.taz0r.eth)`, detail: `${ON_CHAIN} · ${src.name} on Sepolia`,
        });
        break;
      }
      default:
        break;
    }
  }
  return out.sort((a, b) => a.at - b.at || a.block - b.block || a.logIndex - b.logIndex);
}

/** The ENS registries a company is configured with (v1 registryOf, v2 configV2Of); failures are ignored. */
export async function registriesOf(account: Address): Promise<Address[]> {
  const out: Address[] = [];
  const zero = '0x0000000000000000000000000000000000000000';
  const v1 = parseAbi(['function registryOf(address account) view returns (address)']);
  if (config.paymentModule) {
    try {
      const r = decodeFunctionResult({ abi: v1, functionName: 'registryOf', data: await ethCall(config.paymentModule, encodeFunctionData({ abi: v1, functionName: 'registryOf', args: [account] })) });
      if (r !== zero) out.push(r);
    } catch { /* not a v1 company */ }
  }
  if (configV2.paymentModule) {
    try {
      const r = decodeConfigV2(await ethCall(configV2.paymentModule, encodeConfigV2Of(account))).registry;
      if (r !== zero) out.push(r);
    } catch { /* not a v2 company */ }
  }
  return out;
}

export type LoadOptions = { fetch?: typeof fetch; registries?: Address[]; names?: InvoiceNames; sources?: Source[] };
export type ChainHistory = { events: ChainEvent[]; skipped: string[] };

/** Everything the chain says about a company. A source that fails is skipped and named in `skipped`. */
export async function loadChainHistory(account: Address, opts: LoadOptions = {}): Promise<ChainHistory> {
  const sources = opts.sources ?? historySources();
  const failed: (string | null)[] = sources.map(() => null);
  const [batches, registries] = await Promise.all([
    Promise.all(sources.map((src, i) => fetchLogs(src, opts.fetch).then((logs) => ({ src, logs })).catch((e) => {
      failed[i] = `${src.name}: ${e instanceof Error ? e.message : String(e)}`;
      return { src, logs: [] as BlockscoutLog[] };
    }))),
    opts.registries ? Promise.resolve(opts.registries) : registriesOf(account),
  ]);
  const skipped = failed.filter((x): x is string => x !== null); // in source order
  return { events: mapLogs(batches, { account, registries, names: opts.names ?? localInvoiceNames() }), skipped };
}

// ---- merging with this device's log

const key = (e: Pick<TimelineEvent, 'subject' | 'kind' | 'tx'>) => `${e.subject.toLowerCase()}|${e.kind}|${(e.tx ?? '').toLowerCase()}`;

/** Device events plus chain events, deduplicated by subject + kind + tx; a device event confirmed on chain says so. */
export function mergeEvents(device: TimelineEvent[], chain: ChainEvent[]): TimelineEvent[] {
  const onChain = new Map(chain.map((e) => [key(e), e]));
  const merged: TimelineEvent[] = device.map((d) => {
    const c = d.tx ? onChain.get(key(d)) : undefined;
    return c ? { ...d, detail: d.detail ? `${d.detail} · confirmed ${ON_CHAIN}` : `confirmed ${ON_CHAIN}` } : d;
  });
  const seen = new Set(device.map(key));
  for (const c of chain) if (!seen.has(key(c))) merged.push(c);
  return merged.sort((a, b) => a.at - b.at);
}

export const isChainEvent = (e: TimelineEvent): e is ChainEvent => (e as ChainEvent).source === 'chain';

// ---- hooks (60 s sessionStorage cache)

const TTL = 60_000;
const cacheKey = (a: string) => `tazor.chain.v1:${a.toLowerCase()}`;
const inflight = new Map<string, Promise<ChainHistory>>();

function readCache(account: string): ChainHistory | null {
  try {
    const v = JSON.parse(globalThis.sessionStorage?.getItem(cacheKey(account)) ?? 'null') as { at: number; data: ChainHistory } | null;
    return v && Date.now() - v.at < TTL ? v.data : null;
  } catch {
    return null;
  }
}

/** Cached loadChainHistory: one request per account at a time, reused for 60 s. */
export function getChainHistory(account: Address, force = false): Promise<ChainHistory> {
  if (!force) {
    const hit = readCache(account);
    if (hit) return Promise.resolve(hit);
  }
  const k = account.toLowerCase();
  const running = inflight.get(k);
  if (running) return running;
  const p = loadChainHistory(account)
    .then((data) => {
      try { globalThis.sessionStorage?.setItem(cacheKey(account), JSON.stringify({ at: Date.now(), data })); } catch { /* full */ }
      return data;
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export type HistoryState = { events: ChainEvent[]; loading: boolean; error: string | null; skipped: string[]; refresh: () => void };

/** A company's on-chain history, with loading and error state. */
export function useHistory(account: Address | null | undefined): HistoryState {
  const [state, setState] = useState<Omit<HistoryState, 'refresh'>>({ events: [], loading: !!account, error: null, skipped: [] });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!account) { setState({ events: [], loading: false, error: null, skipped: [] }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    getChainHistory(account, nonce > 0)
      .then((h) => live && setState({ events: h.events, loading: false, error: null, skipped: h.skipped }))
      .catch((e) => live && setState({ events: [], loading: false, error: e instanceof Error ? e.message : String(e), skipped: [] }));
    return () => { live = false; };
  }, [account, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

function useDeviceEvents(read: () => TimelineEvent[], deps: unknown[]): TimelineEvent[] {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  useEffect(() => {
    const sync = () => setEvents(read());
    sync();
    globalThis.addEventListener(EVENTS_CHANGED, sync);
    return () => globalThis.removeEventListener(EVENTS_CHANGED, sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return events;
}

/** One subject's timeline: this device's events merged with the chain's, for the account that pays or is paid. */
export function useSubjectHistory(subject: string | null | undefined, account: Address | null | undefined) {
  const device = useDeviceEvents(() => (subject ? eventsFor(subject) : []), [subject]);
  const h = useHistory(subject ? account : null);
  const events = useMemo(
    () => mergeEvents(device, subject ? h.events.filter((e) => e.subject.toLowerCase() === subject.toLowerCase()) : []),
    [device, h.events, subject],
  );
  return { events, loading: h.loading, error: h.error };
}

/** Home "Latest events": newest first, device and chain merged. */
export function useLatestEvents(account: Address | null | undefined, n = 20) {
  const device = useDeviceEvents(() => recentEvents(200), []);
  const h = useHistory(account);
  const events = useMemo(() => mergeEvents(device, h.events).reverse().slice(0, n), [device, h.events, n]);
  return { events, loading: h.loading, error: h.error, skipped: h.skipped };
}
