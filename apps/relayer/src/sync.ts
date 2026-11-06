import { encodeFunctionData, getAddress, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';

export const rolesChanged = parseAbiItem(
  'event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)',
);
export const l1BlockAbi = parseAbi(['function number() view returns (uint64)']);
export const roleCacheAbi = parseAbi([
  'function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)',
  'function syncRoles(address registry, address account, bytes proof)',
]);
export const ensRolesAbi = parseAbi(['function roles(uint256 resource, address account) view returns (uint256)']);

export const L1_BLOCK = '0x4200000000000000000000000000000000000015' as const;
export const ROOT_RESOURCE = 0n;
export const MAX_RANGE = 500n;

/** The witness, and (when the prover reports it) the L1 block the proof reads ENS at: its commit index, which can be older than L1Block.number. */
export type ProvedRoles = { proof: Hex; l1Block?: bigint };
export type Prover = (registry: Address, account: Address) => Promise<Hex | ProvedRoles>;
export const provedOf = (p: Hex | ProvedRoles): ProvedRoles => (typeof p === 'string' ? { proof: p } : p);
export type RoleChange = { registry: Address; account: Address; block: bigint; roles: bigint };

/** Root-resource role changes in [from, to], at most MAX_RANGE blocks per getLogs; the latest change per (registry, account) wins. */
export async function readRoleChanges(l1: PublicClient, registries: Address[], from: bigint, to: bigint, into = new Map<string, RoleChange>()) {
  for (let a = from; a <= to; a += MAX_RANGE) {
    const b = a + MAX_RANGE - 1n < to ? a + MAX_RANGE - 1n : to;
    const logs = await l1.getLogs({ address: registries, event: rolesChanged, args: { resource: ROOT_RESOURCE }, fromBlock: a, toBlock: b });
    for (const l of logs) {
      const registry = getAddress(l.address);
      const account = getAddress(l.args.account!);
      const key = `${registry}:${account}`;
      const prev = into.get(key);
      if (!prev || l.blockNumber! >= prev.block) into.set(key, { registry, account, block: l.blockNumber!, roles: l.args.newRoleBitmap! });
    }
  }
  return into;
}

/** Proves an account's ENS roles and submits RoleCache.syncRoles. */
export async function proveAndSend(
  o: { roleCache: Address; prove: Prover; send: (to: Address, data: Hex) => Promise<Hex> }, registry: Address, account: Address,
): Promise<Hex> {
  const { proof } = provedOf(await o.prove(registry, account));
  return o.send(o.roleCache, encodeFunctionData({ abi: roleCacheAbi, functionName: 'syncRoles', args: [registry, account, proof] }));
}

export type SyncStatus = 'not-watched' | 'in-sync' | 'pending-l1' | 'synced';
export type SyncResult = { registry: Address; account: Address; status: SyncStatus; tx?: Hex; roles?: bigint; l1Block?: bigint };
export type ScanSummary = {
  from: bigint; to: bigint; changes: number;
  results: (SyncResult | { registry: Address; account: Address; status: 'error'; error: string })[];
  deferred: number;
};

export type RoleSync = ReturnType<typeof createRoleSync>;

/** On-demand and stateless role syncing for the hosted relayer (no long-running process). */
export function createRoleSync(opts: {
  l1: PublicClient;
  l2: PublicClient;
  roleCache: Address;
  /** Only these ENS registries are synced (the relayer pays the gas). */
  registries: Address[];
  send: (to: Address, data: Hex) => Promise<Hex>;
  prove: Prover;
  log?: (line: string) => void;
  now?: () => number;
}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? (() => Date.now());
  const registries = opts.registries.map((r) => getAddress(r));
  const watched = (r: Address) => registries.some((x) => x === getAddress(r));

  /**
   * in-sync: the cache holds the ENS roles as of the L1 block Whitechain knows (and ENS has not changed since);
   * pending-l1: it does, but ENS changed after that block, so Whitechain cannot prove the change yet;
   * synced: the cache was stale, so a proof was built and syncRoles sent. Nothing is sent unless the cache is stale.
   */
  async function syncAccount(registryIn: Address, accountIn: Address): Promise<SyncResult> {
    const registry = getAddress(registryIn);
    const account = getAddress(accountIn);
    if (!watched(registry)) return { registry, account, status: 'not-watched' };
    const l2Known = await opts.l2.readContract({ address: L1_BLOCK, abi: l1BlockAbi, functionName: 'number' });
    const ens = (blockNumber?: bigint) =>
      opts.l1.readContract({ address: registry, abi: ensRolesAbi, functionName: 'roles', args: [ROOT_RESOURCE, account], blockNumber });
    const [atKnown, latest, [cached]] = await Promise.all([
      ens(l2Known),
      ens(),
      opts.l2.readContract({ address: opts.roleCache, abi: roleCacheAbi, functionName: 'rolesOf', args: [registry, account] }),
    ]);
    if (cached === atKnown) {
      return { registry, account, status: latest === atKnown ? 'in-sync' : 'pending-l1', roles: atKnown, l1Block: l2Known };
    }
    const started = now();
    const proved = provedOf(await opts.prove(registry, account));
    let roles = atKnown;
    let l1Block = l2Known;
    if (proved.l1Block !== undefined) {
      // The proof reads ENS at its own block. Never write a value that lacks a bit ENS has now (the grant isn't
      // provable yet) or that changes nothing: report pending-l1 and let a later call sync.
      l1Block = proved.l1Block;
      roles = l1Block === l2Known ? atKnown : await ens(l1Block);
      if ((latest & ~roles) !== 0n || roles === cached) {
        log(`deferred ${registry} ${account}: proof block ${l1Block} has roles=0x${roles.toString(16)}, ENS now 0x${latest.toString(16)}, cache 0x${cached.toString(16)}`);
        return { registry, account, status: 'pending-l1', roles: cached, l1Block };
      }
    }
    const tx = await opts.send(opts.roleCache, encodeFunctionData({ abi: roleCacheAbi, functionName: 'syncRoles', args: [registry, account, proved.proof] }));
    log(`synced ${registry} ${account} roles=0x${roles.toString(16)} l1Block=${l1Block} tx=${tx} in ${((now() - started) / 1000).toFixed(1)}s`);
    return { registry, account, status: 'synced', tx, roles, l1Block };
  }

  /** One stateless pass: role changes in the last `lookback` L1 blocks, each (registry, account) synced once. Stops starting new syncs after `budgetMs`. */
  async function scanOnce({ lookback, budgetMs = 45_000 }: { lookback: bigint; budgetMs?: number }): Promise<ScanSummary> {
    const started = now();
    const to = await opts.l1.getBlockNumber();
    const from = to > lookback ? to - lookback : 0n;
    const changes = registries.length ? await readRoleChanges(opts.l1, registries, from, to) : new Map<string, RoleChange>();
    const results: ScanSummary['results'] = [];
    let deferred = 0;
    for (const c of changes.values()) {
      if (now() - started > budgetMs) { deferred++; continue; }
      try {
        results.push(await syncAccount(c.registry, c.account));
      } catch (e) {
        const error = e instanceof Error ? e.message.split('\n')[0] : String(e);
        log(`error ${c.registry} ${c.account} ${error}`);
        results.push({ registry: c.registry, account: c.account, status: 'error', error });
      }
    }
    return { from, to, changes: changes.size, results, deferred };
  }

  return { registries, syncAccount, scanOnce };
}
