import { BaseError, createPublicClient, http, isHex, type Abi, type Address, type Chain, type Hex, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { createSender, type Sender } from '../sender.ts';
import type { RoleSync } from '../sync.ts';
import type { SandboxConfig } from './config.ts';
import type { From, Net, SandboxPorts, SimResult } from './service.ts';

/** Live chain access for the sandbox: one queued sender per key and chain, created on first use. */
export function createSandboxPorts(o: {
  config: SandboxConfig; whitechain: Chain; wcRpc: string; sepoliaRpc: string; relayer?: Sender; roleSync?: RoleSync;
}): SandboxPorts {
  const clients: Record<Net, PublicClient> = {
    whitechain: createPublicClient({ chain: o.whitechain, transport: http(o.wcRpc) }) as PublicClient,
    sepolia: createPublicClient({ chain: sepolia, transport: http(o.sepoliaRpc) }) as PublicClient,
  };
  const senders = new Map<string, Sender>();
  const senderFor = (net: Net, from: From): Sender => {
    if (from === 'relayer') {
      if (!o.relayer || net !== 'whitechain') throw new Error('relayer sender not configured');
      return o.relayer;
    }
    const key = `${net}:${from}`;
    let s = senders.get(key);
    if (!s) {
      s = net === 'whitechain'
        ? createSender({ rpcUrl: o.wcRpc, chain: o.whitechain, privateKey: o.config.keys[from] })
        : createSender({ rpcUrl: o.sepoliaRpc, chain: sepolia, privateKey: o.config.keys[from] });
      senders.set(key, s);
    }
    return s;
  };
  const addressOf = (from: From): Address => (from === 'relayer' ? o.relayer!.address : o.config.eoas[from]);
  return {
    read: <T>(net: Net, address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
      clients[net].readContract({ address, abi, functionName, args } as never) as Promise<T>,
    code: async (address) => (await clients.whitechain.getCode({ address })) ?? '0x',
    send: (net, from, to, data) => senderFor(net, from).send(to, data),
    async simulate(net, from, to, data): Promise<SimResult> {
      try {
        await clients[net].call({ account: addressOf(from), to, data });
        return { ok: true };
      } catch (e) {
        const withData = e instanceof BaseError ? e.walk((x) => isHex((x as { data?: unknown }).data)) as { data?: Hex } | null : null;
        return { ok: false, error: e instanceof BaseError ? e.shortMessage : String(e), data: withData?.data };
      }
    },
    sync: o.roleSync ? (registry, account) => o.roleSync!.syncAccount(registry, account) : undefined,
    async wait(net, hash) {
      const r = await clients[net].waitForTransactionReceipt({ hash, timeout: 45_000 });
      if (r.status !== 'success') throw new Error(`tx ${hash} reverted`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    hasRelayer: !!o.relayer,
  };
}
