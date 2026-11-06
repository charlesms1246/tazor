import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, size, zeroAddress, type Address, type Hex } from 'viem';
import { config } from './config.ts';
import { configV2 } from './config-v2.ts';
import { ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN, decodeConfigV2, encodeConfigV2Of } from './policies.ts';
import { decodeIsRevoked, encodeIsRevokedCall } from './revoke.ts';
import { rpc } from './rpc.ts';
import { verifiedSoulOf } from './soul.ts';

export type Person = {
  address: Address; label: string; roles: string[];
  soul: 'verified' | 'unverified' | 'unknown';
  whitechain: 'in-sync' | 'syncing' | 'revoked' | 'unknown';
};

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

export const labelOf = (a: Address): string => KNOWN_PEOPLE[a.toLowerCase()] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;

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

export function whitechainStatus(r: ApproverView): Person['whitechain'] {
  if (r.revoked) return 'revoked';
  if (r.ens !== null && r.cached !== null) return r.ens === r.cached ? 'in-sync' : 'syncing';
  if (r.revoked === false && r.cached !== null) return 'in-sync';
  return 'unknown';
}

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
  const all = uniqueAddresses([...admins, ...(DEMO_PEOPLE[account.toLowerCase()] ?? [])]);
  const reg = await companyRegistry(account);
  const views: ApproverView[] = reg
    ? await readApprovers(account, reg.registry, reg.revocationList, all, admins)
    : all.map((approver) => ({ approver, admin: admins.some((a) => a.toLowerCase() === approver.toLowerCase()), revoked: null, cached: null, cachedAt: null, ens: null }));
  return Promise.all(views.map(async (v): Promise<Person> => {
    let soul: Person['soul'] = 'unknown';
    if (config.wbSoulMirror) {
      soul = await verifiedSoulOf(config.wbSoulMirror, v.approver).then((id) => (id === null ? 'unverified' : 'verified'), () => 'unknown' as const);
    }
    return { address: v.approver, label: labelOf(v.approver), roles: rolesFor(v), soul, whitechain: whitechainStatus(v) };
  }));
}
