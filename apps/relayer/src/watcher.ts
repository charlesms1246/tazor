import { execFile } from 'node:child_process';
import {
  encodeFunctionData, getAddress, isHex, parseAbi, parseAbiItem,
  type Address, type Hex, type PublicClient,
} from 'viem';

export const rolesChanged = parseAbiItem(
  'event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)',
);
const l1BlockAbi = parseAbi(['function number() view returns (uint64)']);
export const roleCacheAbi = parseAbi([
  'function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)',
  'function syncRoles(address registry, address account, bytes proof)',
]);

export const L1_BLOCK = '0x4200000000000000000000000000000000000015' as const;
const ROOT_RESOURCE = 0n;
const MAX_RANGE = 500n;

export type Prover = (registry: Address, account: Address) => Promise<Hex>;

/** Runs `cmd registry account`; the proof is the last line of stdout. */
export function commandProver(cmd: string, timeoutMs = 180_000): Prover {
  const [file, ...base] = cmd.trim().split(/\s+/);
  return (registry, account) => new Promise((resolve, reject) => {
    execFile(file, [...base, registry, account], { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`prover failed: ${err.message.split('\n')[0]}`));
      const proof = stdout.trim().split('\n').pop()?.trim() ?? '';
      if (!isHex(proof) || proof.length < 4) return reject(new Error('prover printed no proof'));
      resolve(proof);
    });
  });
}

type Pending = { registry: Address; account: Address; block: bigint; roles: bigint };

export function createWatcher(opts: {
  l1: PublicClient;
  l2: PublicClient;
  registries: Address[];
  roleCache: Address;
  send: (to: Address, data: Hex) => Promise<Hex>;
  prove: Prover;
  log?: (line: string) => void;
  lookback?: bigint;
  now?: () => number;
}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? (() => Date.now());
  const registries = opts.registries.map((r) => getAddress(r));
  const pending = new Map<string, Pending>();
  let last: bigint | undefined;
  let running = false;

  async function scan() {
    const head = await opts.l1.getBlockNumber();
    const from = last === undefined ? (head > (opts.lookback ?? 50n) ? head - (opts.lookback ?? 50n) : 0n) : last + 1n;
    if (from > head) return;
    const to = from + MAX_RANGE - 1n < head ? from + MAX_RANGE - 1n : head;
    const logs = await opts.l1.getLogs({
      address: registries, event: rolesChanged, args: { resource: ROOT_RESOURCE }, fromBlock: from, toBlock: to,
    });
    for (const l of logs) {
      const registry = getAddress(l.address);
      const account = getAddress(l.args.account!);
      const key = `${registry}:${account}`;
      const prev = pending.get(key);
      if (!prev || l.blockNumber! >= prev.block) {
        pending.set(key, { registry, account, block: l.blockNumber!, roles: l.args.newRoleBitmap! });
      }
    }
    last = to;
  }

  async function syncOne(key: string, p: Pending, l2Known: bigint) {
    if (l2Known < p.block) return;
    const [, cached] = await opts.l2.readContract({
      address: opts.roleCache, abi: roleCacheAbi, functionName: 'rolesOf', args: [p.registry, p.account],
    });
    if (cached >= p.block) {
      pending.delete(key);
      return;
    }
    const proof = await opts.prove(p.registry, p.account);
    const data = encodeFunctionData({ abi: roleCacheAbi, functionName: 'syncRoles', args: [p.registry, p.account, proof] });
    const tx = await opts.send(opts.roleCache, data);
    pending.delete(key);
    const { timestamp } = await opts.l1.getBlock({ blockNumber: p.block });
    const lag = Math.max(0, Math.round(now() / 1000 - Number(timestamp)));
    log(`synced ${p.registry} ${p.account} roles=0x${p.roles.toString(16)} tx=${tx} lag=${lag}s`);
  }

  /** One poll: read new role events, then sync every pair Whitechain can already prove. Never throws. */
  async function tick() {
    if (running) return;
    running = true;
    try {
      await scan().catch((e) => log(`error scan ${e instanceof Error ? e.message : String(e)}`));
      if (pending.size === 0) return;
      const l2Known = await opts.l2.readContract({ address: L1_BLOCK, abi: l1BlockAbi, functionName: 'number' });
      for (const [key, p] of [...pending]) {
        try {
          await syncOne(key, p, l2Known);
        } catch (e) {
          log(`error ${p.registry} ${p.account} ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        }
      }
    } catch (e) {
      log(`error tick ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    pending: () => [...pending.values()],
    start(intervalMs = 12_000) {
      void tick();
      return setInterval(() => void tick(), intervalMs);
    },
  };
}
