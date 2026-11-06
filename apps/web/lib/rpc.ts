import type { Address, Hex } from 'viem';
import { config } from './config.ts';

export async function rpc<T>(method: string, params: unknown[], url = config.rpcUrl): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

export const ethCall = (to: Address, data: Hex) => rpc<Hex>('eth_call', [{ to, data }, 'latest']);

export type Receipt = { status: Hex; blockNumber: Hex; transactionHash: Hex } | null;
export const getReceipt = (hash: Hex) => rpc<Receipt>('eth_getTransactionReceipt', [hash]);

export const getBlockTimestamp = async (blockNumber: Hex) =>
  Number(BigInt((await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', [blockNumber, false])).timestamp));
