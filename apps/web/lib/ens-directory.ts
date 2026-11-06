import {
  fallback,
  createPublicClient, decodeEventLog, getAddress, http, isAddress, parseAbi, zeroAddress, type Address, type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { config } from './config.ts';

/** The taz0r.eth sub-registry on Ethereum Sepolia (ENSv2): every company is a subname registered here. */
export const TAZ0R_REGISTRY: Address = '0x44007108C0Cca53498F19F259E73E70C2ebE900a';
export const TAZ0R_NAME = 'taz0r.eth';
/** ENSv2 UniversalResolver on Sepolia; resolvers are ENSIP-10 only, so all reads go through it. */
export const UNIVERSAL_RESOLVER: Address = '0x24e1d8e068620b647ca097f961a61055f4f42d72';
export const BLOCKSCOUT_SEPOLIA = 'https://eth-sepolia.blockscout.com';

/** ENSIP-11: an EVM chain's coin type is 0x80000000 | chainId; Ethereum mainnet keeps SLIP-44 coin type 60. */
export function coinTypeForChain(chainId: number): bigint {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId >= 0x80000000) throw new Error(`invalid chainId ${chainId}`);
  return chainId === 1 ? 60n : BigInt(0x80000000) | BigInt(chainId);
}
export const ETH_COIN_TYPE = 60n;
export const WHITECHAIN_SEPOLIA_COIN_TYPE = coinTypeForChain(1874);
export const WHITECHAIN_MAINNET_COIN_TYPE = coinTypeForChain(1875);

export const registryEventsAbi = parseAbi([
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
  'event LabelUnregistered(uint256 indexed tokenId, address indexed sender)',
  'event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)',
]);
const subregistryAbi = parseAbi(['function getSubregistry(string label) view returns (address)']);

export type RawLog = { topics: (Hex | null)[]; data: Hex; block_number: number; index?: number; transaction_hash?: Hex };
export type Subname = { label: string; owner: Address; expiry: number; tokenId: bigint; block: number };
export type RoleHolder = { account: Address; roles: bigint; block: number };

const order = (a: RawLog, b: RawLog) => a.block_number - b.block_number || (a.index ?? 0) - (b.index ?? 0);

/** Live subnames from LabelRegistered / LabelUnregistered, oldest first; a re-registration replaces the earlier one. */
export function subnamesFromLogs(logs: RawLog[]): Subname[] {
  const byLabel = new Map<string, Subname>();
  const byToken = new Map<string, string>();
  for (const l of [...logs].sort(order)) {
    const topics = l.topics.filter((t): t is Hex => !!t);
    if (topics.length === 0) continue;
    try {
      const ev = decodeEventLog({ abi: registryEventsAbi, topics: topics as [Hex, ...Hex[]], data: l.data });
      if (ev.eventName === 'LabelRegistered') {
        const s = { label: ev.args.label, owner: getAddress(ev.args.owner), expiry: Number(ev.args.expiry), tokenId: ev.args.tokenId, block: l.block_number };
        byLabel.set(s.label, s);
        byToken.set(s.tokenId.toString(), s.label);
      } else if (ev.eventName === 'LabelUnregistered') {
        const label = byToken.get(ev.args.tokenId.toString());
        if (label) byLabel.delete(label);
      }
    } catch { /* another event */ }
  }
  return [...byLabel.values()];
}

/** Every account that has had registry-wide (root) roles, with its latest bitmap (0 if since removed). */
export function rootRoleAccountsFromLogs(logs: RawLog[]): RoleHolder[] {
  const latest = new Map<string, RoleHolder>();
  for (const l of [...logs].sort(order)) {
    const topics = l.topics.filter((t): t is Hex => !!t);
    if (topics.length === 0) continue;
    try {
      const ev = decodeEventLog({ abi: registryEventsAbi, topics: topics as [Hex, ...Hex[]], data: l.data });
      if (ev.eventName === 'EACRolesChanged' && ev.args.resource === 0n) {
        latest.set(ev.args.account.toLowerCase(), { account: getAddress(ev.args.account), roles: ev.args.newRoleBitmap, block: l.block_number });
      }
    } catch { /* another event */ }
  }
  return [...latest.values()];
}

/** Accounts whose latest registry-wide (root) role bitmap is non-zero. */
export const rootRoleHoldersFromLogs = (logs: RawLog[]): RoleHolder[] => rootRoleAccountsFromLogs(logs).filter((h) => h.roles !== 0n);

/** All logs of a contract from Blockscout's v2 API (follows pagination up to `maxPages`). */
export async function fetchLogs(address: Address, f: typeof fetch = globalThis.fetch, maxPages = 10): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let params: Record<string, string> | null = {};
  for (let page = 0; params && page < maxPages; page++) {
    const q: string = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res: Response = await f(`${BLOCKSCOUT_SEPOLIA}/api/v2/addresses/${address}/logs${q ? `?${q}` : ''}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`blockscout HTTP ${res.status}`);
    const body: { items?: { topics?: (Hex | null)[]; data?: Hex; block_number: number; index?: number; transaction_hash?: Hex }[]; next_page_params?: Record<string, string> | null } = await res.json();
    for (const i of body.items ?? []) out.push({ topics: i.topics ?? [], data: i.data ?? '0x', block_number: Number(i.block_number), index: Number(i.index ?? 0), transaction_hash: i.transaction_hash });
    params = body.next_page_params ?? null;
  }
  return out;
}

export type CompanyRecords = {
  name?: string; description?: string; url?: string; avatar?: string; role?: string; account?: Address;
  /** `tazor.aliases`: earlier Whitechain accounts of the same company (comma-separated). */
  aliases?: Address[];
  /** `tazor.roles`: the role bit positions this company's registry uses, e.g. {"APPROVER":64,"TAZOR_ADMIN":68,"AGENT":72}. */
  roleBits?: Record<string, number>;
};
export type DirectoryCompany = {
  label: string; ens: string; registry: Address | null; owner: Address; expiry: number;
  name: string; description?: string; url?: string; avatar?: string; role: string | null; account: Address | null;
  aliases: Address[];
  roleBits: Record<string, number> | null;
  /** Kept for older callers: always empty (no field comes from anywhere but ENS). */
  fallback: string[];
};
export type DirectoryMember = { address: Address; label: string; ens?: string; expiry?: number; source: 'ens-text' | 'ens-subname' | 'ens-owner' | 'primary-name' | 'role'; roles?: bigint };
export type Directory = { companies: DirectoryCompany[]; members: Record<string, DirectoryMember[]>; fetchedAt: number; source: 'ens' | 'fallback' };

/** A company exactly as ENS describes it; a missing record stays missing (name falls back to the ENS label). */
export function mergeCompany(s: Subname, registry: Address | null, r: CompanyRecords): DirectoryCompany {
  const role = r.role ? (r.role.toLowerCase() === 'buyer' ? 'Buyer' : r.role.toLowerCase() === 'supplier' ? 'Supplier' : r.role) : null;
  return {
    label: s.label, ens: `${s.label}.${TAZ0R_NAME}`, registry, owner: s.owner, expiry: s.expiry,
    name: r.name || s.label,
    description: r.description || undefined, url: r.url || undefined, avatar: r.avatar || undefined,
    role, account: r.account ?? null, aliases: r.aliases ?? [], roleBits: r.roleBits ?? null,
    fallback: [],
  };
}

/** Parses `tazor.roles` ({"APPROVER":64,...}); null if absent or malformed. */
export function parseRoleBits(text: string | null | undefined): Record<string, number> | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (/^[A-Z_]{1,32}$/.test(k) && Number.isInteger(v) && (v as number) >= 0 && (v as number) < 256) out[k] = v as number;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

export const parseAliases = (text: string | null | undefined): Address[] =>
  (text ?? '').split(/[\s,]+/).filter((a) => isAddress(a, { strict: false })).map((a) => getAddress(a));

type Ens = {
  text: (name: string, key: string) => Promise<string | null>;
  name: (address: Address) => Promise<string | null>;
  addr: (name: string, coinType: bigint) => Promise<Address | null>;
  subregistry: (registry: Address, label: string) => Promise<Address | null>;
};

export function ensClient(rpcUrl?: string): Ens {
  const urls = rpcUrl ? [rpcUrl] : config.sepolia.rpcUrls;
  const c = createPublicClient({ chain: sepolia, transport: fallback(urls.map((u) => http(u, { timeout: 8_000, batch: true, retryCount: 1 })), { rank: false }) });
  return {
    text: (name, key) => c.getEnsText({ name, key, universalResolverAddress: UNIVERSAL_RESOLVER }).catch(() => null),
    name: (address) => c.getEnsName({ address, universalResolverAddress: UNIVERSAL_RESOLVER }).catch(() => null),
    addr: (name, coinType) => c.getEnsAddress({ name, coinType, universalResolverAddress: UNIVERSAL_RESOLVER }).then((a) => (a && isAddress(a) ? getAddress(a) : null)).catch(() => null),
    subregistry: (registry, label) => c.readContract({ address: registry, abi: subregistryAbi, functionName: 'getSubregistry', args: [label] })
      .then((a) => (a === zeroAddress ? null : getAddress(a))).catch(() => null),
  };
}

export async function companyRecords(ens: Ens, name: string): Promise<CompanyRecords> {
  const [n, description, url, avatar, role, account, aliases, roles] = await Promise.all([
    ens.text(name, 'name'), ens.text(name, 'description'), ens.text(name, 'url'), ens.text(name, 'avatar'), ens.text(name, 'tazor.role'),
    ens.addr(name, WHITECHAIN_SEPOLIA_COIN_TYPE), ens.text(name, 'tazor.aliases'), ens.text(name, 'tazor.roles'),
  ]);
  return {
    name: n ?? undefined, description: description ?? undefined, url: url ?? undefined, avatar: avatar ?? undefined, role: role ?? undefined, account: account ?? undefined,
    aliases: parseAliases(aliases), roleBits: parseRoleBits(roles) ?? undefined,
  };
}

/**
 * Members of one company from ENS: subnames with an ETH address (label from their `name` text, else the subname),
 * subname owners, and every account that has held registry-wide roles. Unlabelled accounts use their primary name.
 */
export async function loadMembers(ens: Ens, company: { ens: string; registry: Address }, logs: RawLog[]): Promise<DirectoryMember[]> {
  const members = new Map<string, DirectoryMember>();
  const add = (m: DirectoryMember) => {
    const k = m.address.toLowerCase();
    const prev = members.get(k);
    const rank = (x: DirectoryMember) => ['ens-text', 'ens-subname', 'ens-owner', 'primary-name', 'role'].indexOf(x.source);
    if (!prev || rank(m) < rank(prev)) members.set(k, { ...prev, ...m, roles: m.roles ?? prev?.roles });
    else if (m.roles !== undefined) prev.roles = m.roles;
  };
  await Promise.all(subnamesFromLogs(logs).map(async (s) => {
    const full = `${s.label}.${company.ens}`;
    const [addr, name] = await Promise.all([ens.addr(full, ETH_COIN_TYPE), ens.text(full, 'name')]);
    if (addr) add({ address: addr, label: name || s.label, ens: full, expiry: s.expiry, source: name ? 'ens-text' : 'ens-subname' });
    else add({ address: s.owner, label: s.label, ens: full, expiry: s.expiry, source: 'ens-owner' });
  }));
  for (const h of rootRoleAccountsFromLogs(logs)) add({ address: h.account, label: `${h.account.slice(0, 6)}…${h.account.slice(-4)}`, source: 'role', roles: h.roles });
  await Promise.all([...members.values()].filter((m) => m.source === 'role').map(async (m) => {
    const primary = await ens.name(m.address);
    if (primary) { m.label = primary; m.source = 'primary-name'; }
  }));
  return [...members.values()];
}

/** Subnames of a company registry with their owner and expiry (contractors, agent namespaces). */
export const companySubnames = (logs: RawLog[]): Subname[] => subnamesFromLogs(logs);

/** Reads every company under taz0r.eth and its members from ENS. Throws only if the registry logs are unreadable. */
export async function loadDirectory(opts: { ens?: Ens; f?: typeof fetch } = {}): Promise<Directory> {
  const ens = opts.ens ?? ensClient();
  const f = opts.f ?? globalThis.fetch;
  const subs = subnamesFromLogs(await fetchLogs(TAZ0R_REGISTRY, f));
  const companies = await Promise.all(subs.map(async (s) => {
    const registry = await ens.subregistry(TAZ0R_REGISTRY, s.label);
    return mergeCompany(s, registry, await companyRecords(ens, `${s.label}.${TAZ0R_NAME}`));
  }));
  const members: Record<string, DirectoryMember[]> = {};
  await Promise.all(companies.filter((c) => c.registry).map(async (c) => {
    try {
      members[c.label] = await loadMembers(ens, { ens: c.ens, registry: c.registry! }, await fetchLogs(c.registry!, f));
    } catch { members[c.label] = []; }
  }));
  return { companies, members, fetchedAt: Date.now(), source: 'ens' };
}

const KEY = 'tazor.ens-directory.v2'; // v2: no static fallback values
export const DIRECTORY_EVENT = 'tazor:ens-directory';
export const DIRECTORY_TTL_MS = 5 * 60_000;

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v);
const reviver = (_: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export function cachedDirectory(): Directory | null {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v ? (JSON.parse(v, reviver) as Directory) : null;
  } catch {
    return null;
  }
}

function storeDirectory(d: Directory) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(d, replacer)); } catch { /* storage unavailable */ }
  globalThis.dispatchEvent?.(new Event(DIRECTORY_EVENT));
}

let inflight: Promise<Directory | null> | null = null;
let lastFailed = false;

/** Refreshes the cached directory from ENS at most every DIRECTORY_TTL_MS; never throws. */
export function refreshDirectory(force = false): Promise<Directory | null> {
  const cached = cachedDirectory();
  if (!force && cached && Date.now() - cached.fetchedAt < DIRECTORY_TTL_MS) return Promise.resolve(cached);
  if (!inflight) globalThis.dispatchEvent?.(new Event(DIRECTORY_EVENT)); // "loading" for listeners
  inflight ??= loadDirectory()
    .then((d) => { lastFailed = false; storeDirectory(d); return d; }, () => { lastFailed = true; globalThis.dispatchEvent?.(new Event(DIRECTORY_EVENT)); return cached; })
    .finally(() => { inflight = null; });
  return inflight;
}

export type DirectoryStatus = 'loading' | 'ready' | 'error';

/** ready: a directory from ENS is cached; loading: the first read is in flight; error: ENS couldn't be read and nothing is cached. */
export function directoryStatus(): DirectoryStatus {
  if (cachedDirectory()) return 'ready';
  return lastFailed && !inflight ? 'error' : 'loading';
}

/** Retry after "Couldn't read ENS". */
export const retryDirectory = () => refreshDirectory(true);

/** ENS name or member label for an address, from the cached directory (companies first, then members). */
export function ensLabelOf(a: string, d: Directory | null = cachedDirectory()): string | null {
  if (!d) return null;
  const l = a.toLowerCase();
  const c = d.companies.find((x) => x.account?.toLowerCase() === l);
  if (c) return c.ens;
  const earlier = d.companies.find((x) => (x.aliases ?? []).some((a) => a.toLowerCase() === l));
  if (earlier) return `${earlier.ens} (earlier account)`;
  for (const list of Object.values(d.members)) {
    const m = list.find((x) => x.address.toLowerCase() === l && x.source !== 'role');
    if (m) return m.source === 'ens-owner' ? m.ens ?? m.label : m.label;
  }
  return null;
}

/** A member's directory entry for one company account, if ENS knows them. */
export function memberOf(account: string, person: string, d: Directory | null = cachedDirectory()): DirectoryMember | null {
  if (!d) return null;
  const c = d.companies.find((x) => x.account?.toLowerCase() === account.toLowerCase());
  return (c && d.members[c.label]?.find((m) => m.address.toLowerCase() === person.toLowerCase())) ?? null;
}
