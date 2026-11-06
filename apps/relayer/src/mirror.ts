import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem';

const ROLE_APPROVER = 1n << 64n;
const revokedEvent = parseAbi(['event ApproverRevoked(address indexed account, address indexed target, address indexed admin)']);
const paymentAbi = parseAbi(['function registryOf(address account) view returns (address)']);
const registryAbi = parseAbi([
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
]);

export type MirrorDeps = {
  l2: PublicClient;
  l1: PublicClient;
  revocationLists: { list: Address; paymentModule: Address }[];
  send: (to: Address, data: Hex) => Promise<Hex>;
  log?: (line: string) => void;
  lookback?: bigint;
};

/// Mirrors Whitechain revocations into the company's ENSv2 registry: when an approver is revoked on
/// Whitechain and still holds APPROVER on Ethereum, revoke that root role there too.
export function createMirror(d: MirrorDeps) {
  const log = d.log ?? console.log;
  let from: bigint | undefined;
  const pending = new Map<string, { registry: Address; target: Address }>();
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const head = await d.l2.getBlockNumber();
      const start = from ?? (head > (d.lookback ?? 200n) ? head - (d.lookback ?? 200n) : 0n);
      for (const { list, paymentModule } of d.revocationLists) {
        const logs = await d.l2.getLogs({ address: list, event: revokedEvent[0], fromBlock: start, toBlock: head });
        for (const l of logs) {
          const { args } = decodeEventLog({ abi: revokedEvent, data: l.data, topics: l.topics });
          const registry = await d.l2.readContract({ address: paymentModule, abi: paymentAbi, functionName: 'registryOf', args: [args.account] });
          if (registry !== '0x0000000000000000000000000000000000000000') pending.set(`${registry}:${args.target}`, { registry, target: args.target });
        }
      }
      from = head + 1n;
      for (const [k, { registry, target }] of pending) {
        try {
          const roles = await d.l1.readContract({ address: registry, abi: registryAbi, functionName: 'roles', args: [0n, target] });
          if ((roles & ROLE_APPROVER) === 0n) {
            pending.delete(k);
            continue;
          }
          const tx = await d.send(registry, encodeFunctionData({ abi: registryAbi, functionName: 'revokeRootRoles', args: [ROLE_APPROVER, target] }));
          log(`mirrored revoke ${registry} ${target} tx=${tx}`);
          pending.delete(k);
        } catch (e) {
          log(`error ${registry} ${target} ${(e as Error).message.split('\n')[0]}`);
        }
      }
    } catch (e) {
      log(`error tick ${(e as Error).message.split('\n')[0]}`);
    } finally {
      running = false;
    }
  }

  return { tick, start: (ms: number) => setInterval(tick, ms), pendingCount: () => pending.size };
}
