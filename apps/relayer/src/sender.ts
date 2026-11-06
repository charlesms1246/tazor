import { BaseError, createPublicClient, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export class SimulationFailed extends Error {}

export function createSender(opts: { rpcUrl: string; chain: Chain; privateKey: Hex }) {
  const client = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const account = privateKeyToAccount(opts.privateKey);
  let queue: Promise<unknown> = Promise.resolve();

  async function sendOne(to: Address, data: Hex): Promise<{ txHash: Hex; done: Promise<unknown> }> {
    try {
      await client.call({ account: account.address, to: to, data });
    } catch (e) {
      throw new SimulationFailed(e instanceof BaseError ? e.shortMessage : String(e));
    }
    const [nonce, gas, fees] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      client.estimateGas({ account: account.address, to: to, data }),
      client.estimateFeesPerGas(),
    ]);
    const serialized = await account.signTransaction({
      chainId: opts.chain.id, type: 'eip1559', to: to, data, nonce, gas: (gas * 12n) / 10n,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const txHash = await client.sendRawTransaction({ serializedTransaction: serialized });
    return { txHash, done: client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 }) };
  }

  return {
    address: account.address,
    send(to: Address, data: Hex): Promise<Hex> {
      const result = queue.then(() => sendOne(to, data));
      queue = result.then((r) => r.done, () => undefined).catch(() => undefined);
      return result.then((r) => r.txHash);
    },
  };
}

export type Sender = ReturnType<typeof createSender>;
