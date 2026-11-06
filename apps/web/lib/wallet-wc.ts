import { toHex, type Address, type Hex } from 'viem';
import { config } from './config.ts';

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** Sends a Whitechain Sepolia transaction from the browser wallet (EIP-1193), adding the chain if needed. */
export async function sendOnWhitechain(to: Address, data: Hex): Promise<Hex> {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No browser wallet found; use "Copy calldata" instead.');
  const [from] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
  const chainId = toHex(config.chainId);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: 'Whitechain Sepolia', rpcUrls: [config.rpcUrl], nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, blockExplorerUrls: [config.explorer] }],
    });
  }
  return (await eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] })) as Hex;
}
