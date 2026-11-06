import { encodeFunctionData, getAddress, isAddressEqual, parseAbi, parseAbiItem, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';

export const ROLE_APPROVER = 1n << 64n;
/** EnhancedAccessControl: the admin of a role is the same bit shifted up 128. */
export const ROLE_APPROVER_ADMIN = ROLE_APPROVER << 128n;
export const MIRROR_LOOKBACK = 90_000n;
const CHUNK = 10_000n;

const revokedEvent = parseAbiItem('event ApproverRevoked(address indexed account, address indexed target, address indexed admin)');
const listAbi = parseAbi(['function isRevoked(address account, address approver) view returns (bool)']);
const paymentAbi = parseAbi(['function registryOf(address account) view returns (address)']);
const registryAbi = parseAbi([
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
]);

export type MirrorStatus = 'mirrored' | 'already-mirrored' | 'not-revoked' | 'not-a-company' | 'not-watched' | 'not-authorized';
export type MirrorResult = { account: Address; target: Address; status: MirrorStatus; registry?: Address; tx?: Hex };
export type MirrorHealth = { mirrorEnabled: boolean; reason?: string; sender: Address | null; authorized: Address[] };

/**
 * On-demand mirroring of Whitechain revocations to the company's ENSv2 registry on Sepolia.
 * Only for WATCH_REGISTRIES, only when the RevocationList says revoked and ENS still shows APPROVER,
 * and only when the Sepolia sender already holds the APPROVER admin role there (nothing is granted here).
 */
export function createMirrorService(d: {
  l1: PublicClient;
  l2: PublicClient;
  /** RevocationList → the PaymentModule whose registryOf maps accounts to registries. */
  lists: { list: Address; paymentModule: Address }[];
  registries: Address[];
  /** Sepolia sender (same key as the relayer); absent when no key is configured. */
  sender?: { address: Address; send: (to: Address, data: Hex) => Promise<Hex> };
  lookback?: bigint;
}) {
  const registries = d.registries.map((r) => getAddress(r));
  const watched = (r: Address) => registries.some((x) => isAddressEqual(x, r));
  // Admin rights are re-read every 10 minutes, so a later grant takes effect without a redeploy.
  const authCache = new Map<string, { ok: boolean; at: number }>();

  async function authorized(registry: Address): Promise<boolean> {
    if (!d.sender) return false;
    const k = registry.toLowerCase();
    const hit = authCache.get(k);
    if (hit && Date.now() - hit.at < 600_000) return hit.ok;
    const roles = await d.l1.readContract({ address: registry, abi: registryAbi, functionName: 'roles', args: [0n, d.sender.address] });
    const ok = (roles & ROLE_APPROVER_ADMIN) !== 0n;
    authCache.set(k, { ok, at: Date.now() });
    return ok;
  }

  async function health(): Promise<MirrorHealth> {
    const sender = d.sender?.address ?? null;
    if (!d.sender) return { mirrorEnabled: false, reason: 'no RELAYER_PRIVATE_KEY, so there is no Sepolia sender', sender, authorized: [] };
    if (registries.length === 0) return { mirrorEnabled: false, reason: 'WATCH_REGISTRIES is empty', sender, authorized: [] };
    const ok: Address[] = [];
    try {
      for (const r of registries) if (await authorized(r)) ok.push(r);
    } catch (e) {
      return { mirrorEnabled: false, reason: `could not read ENS roles on Sepolia: ${(e as Error).message.split('\n')[0]}`, sender, authorized: [] };
    }
    if (ok.length === 0) return { mirrorEnabled: false, reason: `the relayer address ${sender} is not an APPROVER admin on any watched registry; a company admin must grant it before revocations can be mirrored`, sender, authorized: [] };
    return { mirrorEnabled: true, sender, authorized: ok, ...(ok.length < registries.length ? { reason: `not an APPROVER admin on ${registries.length - ok.length} of ${registries.length} watched registries` } : {}) };
  }

  /** Mirrors one (company account, revoked approver) pair. Throws only on RPC or send failures. */
  async function mirrorOne(account: Address, target: Address): Promise<MirrorResult> {
    let registry: Address | undefined;
    let revoked = false;
    for (const { list, paymentModule } of d.lists) {
      const r = await d.l2.readContract({ address: paymentModule, abi: paymentAbi, functionName: 'registryOf', args: [account] });
      if (isAddressEqual(r, zeroAddress)) continue;
      registry ??= getAddress(r);
      if (await d.l2.readContract({ address: list, abi: listAbi, functionName: 'isRevoked', args: [account, target] })) { registry = getAddress(r); revoked = true; break; }
    }
    if (!registry) return { account, target, status: 'not-a-company' };
    if (!watched(registry)) return { account, target, status: 'not-watched', registry };
    if (!revoked) return { account, target, status: 'not-revoked', registry };
    const roles = await d.l1.readContract({ address: registry, abi: registryAbi, functionName: 'roles', args: [0n, target] });
    if ((roles & ROLE_APPROVER) === 0n) return { account, target, status: 'already-mirrored', registry };
    if (!d.sender || !(await authorized(registry))) return { account, target, status: 'not-authorized', registry };
    const tx = await d.sender.send(registry, encodeFunctionData({ abi: registryAbi, functionName: 'revokeRootRoles', args: [ROLE_APPROVER, target] }));
    return { account, target, status: 'mirrored', registry, tx };
  }

  /** A pass over recent ApproverRevoked events (GET /watch). Never throws; per-pair errors are reported. */
  async function scanOnce(): Promise<{ from: string; to: string; results: (MirrorResult | { account: Address; target: Address; status: 'error'; error: string })[]; error?: string }> {
    const results: (MirrorResult | { account: Address; target: Address; status: 'error'; error: string })[] = [];
    let head = 0n;
    let from = 0n;
    try {
      head = await d.l2.getBlockNumber();
      const lookback = d.lookback ?? MIRROR_LOOKBACK;
      from = head > lookback ? head - lookback : 0n;
      const pairs = new Map<string, { account: Address; target: Address }>();
      for (const { list } of d.lists) {
        for (let a = from; a <= head; a += CHUNK) {
          const b = a + CHUNK - 1n < head ? a + CHUNK - 1n : head;
          const logs = await d.l2.getLogs({ address: list, event: revokedEvent, fromBlock: a, toBlock: b });
          for (const l of logs) {
            const { account, target } = l.args as { account: Address; target: Address };
            pairs.set(`${account}:${target}`.toLowerCase(), { account: getAddress(account), target: getAddress(target) });
          }
        }
      }
      for (const { account, target } of pairs.values()) {
        try {
          results.push(await mirrorOne(account, target));
        } catch (e) {
          results.push({ account, target, status: 'error', error: (e as Error).message.split('\n')[0] });
        }
      }
      return { from: from.toString(), to: head.toString(), results };
    } catch (e) {
      return { from: from.toString(), to: head.toString(), results, error: (e as Error).message.split('\n')[0] };
    }
  }

  return { health, mirrorOne, scanOnce, registries };
}

export type MirrorService = ReturnType<typeof createMirrorService>;
