import { BaseError, type Abi, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem';
import type { Sender } from '../sender.ts';
import type { ChainLog, CheckoutChain } from './service.ts';
import type { X402Chain } from './x402.ts';

const LOG_CHUNK = 50_000n;

/** Live Whitechain access for checkout and x402: reads, chunked log scans, the relayer's queued sender, receipts. */
export function liveChain(client: PublicClient, sender: Sender): CheckoutChain & X402Chain {
  return {
    read: <T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
      client.readContract({ address, abi, functionName, args } as never) as Promise<T>,
    async logs(address: Address, event: AbiEvent, args: Record<string, unknown>, fromBlock: bigint): Promise<ChainLog[]> {
      const head = await client.getBlockNumber();
      const out: ChainLog[] = [];
      for (let a = fromBlock; a <= head; a += LOG_CHUNK) {
        const b = a + LOG_CHUNK - 1n < head ? a + LOG_CHUNK - 1n : head;
        const logs = await client.getLogs({ address, event, args, fromBlock: a, toBlock: b } as never) as unknown as { transactionHash: Hex; blockNumber: bigint; args: Record<string, unknown> }[];
        for (const l of logs) out.push({ transactionHash: l.transactionHash, blockNumber: l.blockNumber, args: l.args });
      }
      return out;
    },
    async block(tag) {
      const b = typeof tag === 'bigint' ? await client.getBlock({ blockNumber: tag }) : await client.getBlock({ blockTag: tag });
      return { number: b.number!, timestamp: b.timestamp };
    },
    send: (to, data) => sender.send(to, data),
    async wait(hash) {
      const r = await client.waitForTransactionReceipt({ hash, timeout: 45_000 });
      return { status: r.status, blockNumber: r.blockNumber };
    },
    async simulate(to, data) {
      try {
        await client.call({ account: sender.address, to, data });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ''}` : String(e) };
      }
    },
  };
}
