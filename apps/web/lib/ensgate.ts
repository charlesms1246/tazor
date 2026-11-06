import { decodeEventLog, encodeEventTopics, encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { ensGateAbi } from './abi/EnsGate.ts';
import { paymentModuleAbi } from './abi/PaymentModule.ts';
import { config } from './config.ts';
import type { InvoiceAuth } from './invoice-auth.ts';
import type { Approval } from './payment.ts';
import { rpc } from './rpc.ts';

export const encodeForward = (label: string, auth: InvoiceAuth, approvals: Approval[]): Hex =>
  encodeFunctionData({
    abi: ensGateAbi,
    functionName: 'forward',
    args: [label, auth.account, auth, approvals.map((a) => a.approver), approvals.map((a) => a.signature)],
  });

export async function estimateForwardFee(to: Address, data: Hex, from?: Address) {
  const url = config.sepolia.rpcUrl;
  const [gas, gasPrice] = await Promise.all([
    rpc<Hex>('eth_estimateGas', [{ to, data, ...(from ? { from } : {}) }], url),
    rpc<Hex>('eth_gasPrice', [], url),
  ]);
  return { gas: BigInt(gas), gasPrice: BigInt(gasPrice), fee: BigInt(gas) * BigInt(gasPrice) };
}

export const invoicePaidTopics = (account: Address, nonce: bigint) =>
  encodeEventTopics({ abi: paymentModuleAbi, eventName: 'InvoicePaid', args: { account, nonce } });

type Log = { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex };

export async function findInvoicePaidViaL1(paymentModule: Address, account: Address, nonce: bigint, fromBlock: bigint) {
  const logs = await rpc<Log[]>('eth_getLogs', [{
    address: paymentModule, topics: invoicePaidTopics(account, nonce), fromBlock: toHex(fromBlock), toBlock: 'latest',
  }]);
  for (const l of logs) {
    const ev = decodeEventLog({ abi: paymentModuleAbi, eventName: 'InvoicePaid', topics: l.topics as [Hex, ...Hex[]], data: l.data });
    if (ev.args.viaL1) return { txHash: l.transactionHash, blockNumber: BigInt(l.blockNumber) };
  }
  return null;
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export async function sendWithInjectedWallet(to: Address, data: Hex, gas: bigint): Promise<Hex> {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('No browser wallet found; use "Copy calldata" instead.');
  const [from] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
  const chainId = toHex(config.sepolia.chainId);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: 'Sepolia', rpcUrls: [config.sepolia.rpcUrl], nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: [config.sepolia.explorer] }],
    });
  }
  return (await eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas: toHex((gas * 12n) / 10n) }] })) as Hex;
}
