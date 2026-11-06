import { execFile } from 'node:child_process';
import { getAddress, isHex, type Address, type Hex, type PublicClient } from 'viem';
import {
  L1_BLOCK, MAX_RANGE, l1BlockAbi, proveAndSend, readRoleChanges, roleCacheAbi, type Prover, type RoleChange,
} from './sync.ts';

export { L1_BLOCK, roleCacheAbi, rolesChanged, type Prover } from './sync.ts';

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

type Pending = RoleChange;

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
    await readRoleChanges(opts.l1, registries, from, to, pending);
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
    const tx = await proveAndSend(opts, p.registry, p.account);
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
