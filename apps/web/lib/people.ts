import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, size, zeroAddress, type Address, type Hex } from 'viem';
import { config } from './config.ts';
import { configV2 } from './config-v2.ts';
import { ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN, decodeConfigV2, encodeConfigV2Of } from './policies.ts';
import { decodeIsRevoked, encodeIsRevokedCall } from './revoke.ts';
import { rpc } from './rpc.ts';
import { verifiedSoulOf } from './soul.ts';
import { cachedDirectory, ensLabelOf, refreshDirectory, type Directory, type DirectoryMember } from './ens-directory.ts';

export type Person = {
  address: Address; label: string; roles: string[];
  soul: 'verified' | 'unverified' | 'unknown';
  whitechain: 'in-sync' | 'syncing' | 'out-of-sync' | 'revoked' | 'unknown';
  /** L1 block of this person's role-cache entry (0 or undefined: never synced). */
  cachedAt?: number;
  /** Approximate age of that cache entry, from Whitechain's L1Block view of Ethereum. */
  cacheAgeSec?: number;
  /** Raw role bitmaps: live ENS (source of truth) and Whitechain's role cache; undefined if unreadable. */
  ensBits?: bigint;
  cacheBits?: bigint;
  /** Where the label came from: ENS (a member's name text, subname or primary name), the static fallback, or the address. */
  labelSource?: 'ens' | 'fallback' | 'address';
  /** The person's ENS subname under the company, if any. */
  ensName?: string;
};

/** Ethereum (Sepolia) block time used to turn L1 block distance into seconds. */
export const L1_BLOCK_SECONDS = 12;
/** A role mismatch younger than this is treated as a sync in flight. */
export const SYNC_GRACE_SECONDS = 600;

export const cacheAgeSeconds = (cachedAt: bigint | null, l1Now: bigint | null): number | null =>
  cachedAt !== null && cachedAt > 0n && l1Now !== null && l1Now >= cachedAt ? Number(l1Now - cachedAt) * L1_BLOCK_SECONDS : null;

/** What Whitechain and ENS say about one approver of one company. */
export type ApproverView = {
  approver: Address; admin: boolean; revoked: boolean | null; cached: bigint | null; cachedAt: bigint | null; ens: bigint | null;
};

export const peopleAbi = parseAbi([
  'function getSignerCount() view returns (uint256)',
  'function getSigners(uint64 start, uint64 end) view returns (bytes[])',
  'function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)',
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function number() view returns (uint64)',
  'function registryOf(address account) view returns (address)',
]);

export const L1_BLOCK: Address = '0x4200000000000000000000000000000000000015';

export const KNOWN_PEOPLE: Record<string, string> = {
  '0x00abed5bdddf794c415ee746d3e4de5332cc5450': 'Priya (Finance)',
  '0x20ba842dc15cbcf4e02d8ce77e07391a949bb967': 'CFO (Finance)',
  '0xed7335f5ad5e60691b0d88a4b8921a65c7e4c3cb': 'Ravi (Operations)',
  '0x03c291d446b870e0b8f128681937a9eceda97763': 'Meera (EIP-7702 wallet)',
};

/** Demo people tracked for a company in addition to its signers. */
export const DEMO_PEOPLE: Record<string, Address[]> = {
  [configV2.demoAccount.toLowerCase()]: [
    '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967',
    '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb', '0x03C291d446b870e0B8F128681937a9eCEDa97763',
  ],
};

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isShort = (label: string) => /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/.test(label);

/** A person's label and its source: ENS first, then the static demo labels, then the short address. */
export function labelInfo(a: Address, member?: DirectoryMember | null, d: Directory | null = cachedDirectory()): { label: string; source: 'ens' | 'fallback' | 'address' } {
  const fromMember = member && !isShort(member.label) ? member.label : null;
  const ens = fromMember ?? ensLabelOf(a, d);
  if (ens && !isShort(ens)) return { label: ens, source: 'ens' };
  const fb = KNOWN_PEOPLE[a.toLowerCase()];
  if (fb) return { label: fb, source: 'fallback' };
  return { label: shortAddr(a), source: 'address' };
}

export const labelOf = (a: Address): string => labelInfo(a).label;

export const roleList = (bits: bigint): string[] =>
  [bits & ROLE_APPROVER ? 'Approver' : '', bits & ROLE_TAZOR_ADMIN ? 'Admin' : '', bits & ROLE_AGENT ? 'Agent' : ''].filter(Boolean);

/** Lower-case role names joined, as shown in the approvers table. */
export const roleNames = (bits: bigint): string => roleList(bits).map((r) => r.toLowerCase()).join(', ') || 'none';

export function approverFlags(r: ApproverView): string[] {
  const flags: string[] = [];
  if (r.revoked && r.ens !== null && (r.ens & ROLE_APPROVER) !== 0n) flags.push('Revoked on Whitechain but still listed on ENS (mirror pending)');
  if (r.ens !== null && r.cached !== null && r.ens !== r.cached) flags.push('ENS role changed, cache stale (sync pending)');
  return flags;
}

/**
 * Whitechain's view of one approver. A mismatch between ENS and the role cache only counts as "syncing" when the
 * cache entry is younger than SYNC_GRACE_SECONDS; an older or undated mismatch is "out-of-sync" (someone must run syncRoles).
 */
export function whitechainStatus(r: ApproverView, l1Now: bigint | null = null): Person['whitechain'] {
  if (r.revoked) return 'revoked';
  if (r.ens !== null && r.cached !== null) {
    if (r.ens === r.cached) return 'in-sync';
    const age = cacheAgeSeconds(r.cachedAt, l1Now);
    return age !== null && age <= SYNC_GRACE_SECONDS ? 'syncing' : 'out-of-sync';
  }
  if (r.revoked === false && r.cached !== null) return 'in-sync';
  return 'unknown';
}

/** Rough "N min/h/d ago" for a number of seconds. */
export function agoText(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s ago`;
  if (sec < 90 * 60) return `~${Math.round(sec / 60)} min ago`;
  if (sec < 36 * 3600) return `~${Math.round(sec / 3600)} h ago`;
  return `~${Math.round(sec / 86400)} d ago`;
}

/** Whitechain's current view of the Ethereum block number (L1Block), or null if unreadable. */
export const l1BlockNumber = (): Promise<bigint | null> => call<bigint>(L1_BLOCK, 'number').catch(() => null);

export function rolesFor(r: ApproverView): string[] {
  const bits = r.ens ?? r.cached ?? 0n;
  const list = roleList(bits);
  if (r.admin && !list.includes('Admin')) list.push('Admin');
  return list;
}

export const uniqueAddresses = (list: Address[]): Address[] => [...new Map(list.map((a) => [a.toLowerCase(), getAddress(a)])).values()];

const call = <T,>(to: Address, functionName: string, args: readonly unknown[] = [], url?: string) =>
  rpc<Hex>('eth_call', [{ to, data: encodeFunctionData({ abi: peopleAbi, functionName, args } as never) }, 'latest'], url)
    .then((data) => decodeFunctionResult({ abi: peopleAbi, functionName, data } as never) as T);

/** 20-byte signers of a Tazor account (its admins). */
export async function adminSigners(account: Address): Promise<Address[]> {
  const n = await call<bigint>(account, 'getSignerCount');
  const signers = n > 0n ? await call<Hex[]>(account, 'getSigners', [0n, n]) : [];
  return signers.filter((s) => size(s) === 20).map((s) => getAddress(s));
}

/** Reads the revocation list, role cache and live ENS roles for each approver. */
export async function readApprovers(account: Address, registry: Address, revocationList: Address | null, approvers: Address[], admins: Address[]): Promise<ApproverView[]> {
  return Promise.all(approvers.map(async (approver): Promise<ApproverView> => {
    const revoked = revocationList ? await rpc<Hex>('eth_call', [{ to: revocationList, data: encodeIsRevokedCall(account, approver) }, 'latest']).then(decodeIsRevoked).catch(() => null) : null;
    const cache = config.roleCache ? await call<readonly [bigint, bigint]>(config.roleCache, 'rolesOf', [registry, approver]).catch(() => null) : null;
    const ens = await call<bigint>(registry, 'roles', [0n, approver], config.sepolia.rpcUrl).catch(() => null);
    return { approver, admin: admins.some((a) => a.toLowerCase() === approver.toLowerCase()), revoked, cached: cache?.[0] ?? null, cachedAt: cache?.[1] ?? null, ens };
  }));
}

/** The company's ENS registry and revocation list: v2 config first, then v1. */
export async function companyRegistry(account: Address): Promise<{ registry: Address; revocationList: Address | null } | null> {
  if (configV2.paymentModule) {
    try {
      const c = decodeConfigV2(await rpc<Hex>('eth_call', [{ to: configV2.paymentModule, data: encodeConfigV2Of(account) }, 'latest']));
      if (c.registry !== zeroAddress) return { registry: c.registry, revocationList: configV2.revocationList };
    } catch { /* not v2 */ }
  }
  if (config.paymentModule) {
    try {
      const reg = await call<Address>(config.paymentModule, 'registryOf', [account]);
      if (reg !== zeroAddress) return { registry: reg, revocationList: config.revocationList };
    } catch { /* not v1 */ }
  }
  return null;
}

/** Everyone who acts for a company: its admin signers plus the known demo people, with roles and status. */
export async function loadPeople(account: Address): Promise<Person[]> {
  const admins = await adminSigners(account).catch(() => [] as Address[]);
  const dir = await refreshDirectory().catch(() => null);
  const company = dir?.companies.find((c) => c.account?.toLowerCase() === account.toLowerCase());
  const members = (company && dir?.members[company.label]) || [];
  const memberOf = (a: Address) => members.find((m) => m.address.toLowerCase() === a.toLowerCase()) ?? null;
  // ENS members are the source of truth; the demo list only fills in when ENS lists nobody for this company.
  const candidates = members.length ? members.map((m) => m.address) : DEMO_PEOPLE[account.toLowerCase()] ?? [];
  const all = uniqueAddresses([...admins, ...candidates]);
  const [reg, l1Now] = await Promise.all([companyRegistry(account), l1BlockNumber()]);
  const views: ApproverView[] = reg
    ? await readApprovers(account, reg.registry, reg.revocationList, all, admins)
    : all.map((approver) => ({ approver, admin: admins.some((a) => a.toLowerCase() === approver.toLowerCase()), revoked: null, cached: null, cachedAt: null, ens: null }));
  return Promise.all(views.map(async (v): Promise<Person> => {
    let soul: Person['soul'] = 'unknown';
    if (config.wbSoulMirror) {
      soul = await verifiedSoulOf(config.wbSoulMirror, v.approver).then((id) => (id === null ? 'unverified' : 'verified'), () => 'unknown' as const);
    }
    const age = cacheAgeSeconds(v.cachedAt, l1Now);
    const m = memberOf(v.approver);
    const info = labelInfo(v.approver, m, dir);
    return {
      address: v.approver, label: info.label, labelSource: info.source, ...(m?.ens ? { ensName: m.ens } : {}),
      roles: rolesFor(v), soul, whitechain: whitechainStatus(v, l1Now),
      ...(v.cachedAt !== null ? { cachedAt: Number(v.cachedAt) } : {}), ...(age !== null ? { cacheAgeSec: age } : {}),
      ...(v.ens !== null ? { ensBits: v.ens } : {}), ...(v.cached !== null ? { cacheBits: v.cached } : {}),
    };
  }));
}
