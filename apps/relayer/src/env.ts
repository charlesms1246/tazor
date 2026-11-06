import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { createHandler } from './app.ts';
import { createApproverDeployer } from './approver.ts';
import { createSender } from './sender.ts';

/** Builds the relayer's request handler from environment variables. */
export function handlerFromEnv(env: Record<string, string | undefined> = process.env) {
  const rpcUrl = env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
  const whitechainSepolia = defineChain({
    id: Number(env.CHAIN_ID ?? 1874),
    name: 'Whitechain Sepolia',
    nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const paymentModule = getAddress(env.PAYMENT_MODULE || '0xe19ddf1fd417B146137A5dE6eb56c4589431540A');
  const approverFactory = getAddress(env.APPROVER_ACCOUNT_FACTORY || '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e');
  const revocationList = getAddress(env.REVOCATION_LIST || '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e');
  const mandateModule = getAddress(env.MANDATE_MODULE || '0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32');
  const raw = env.RELAYER_PRIVATE_KEY?.trim();
  const key = (raw ? (raw.startsWith('0x') ? raw : `0x${raw}`) : undefined) as Hex | undefined;
  const sender = key ? createSender({ rpcUrl, chain: whitechainSepolia, privateKey: key }) : undefined;
  const client = createPublicClient({ chain: whitechainSepolia, transport: http(rpcUrl) });
  const approvers = createApproverDeployer(client, approverFactory);

  const paymaster = env.PAYMASTER ? getAddress(env.PAYMASTER) : undefined;
  const handler = createHandler({ sender, paymentModule, approvers, revocationList, mandateModule, client: client as never, paymaster, chainId: whitechainSepolia.id });
  return { handler, sender, paymentModule, approverFactory, revocationList, mandateModule, paymaster, chainId: whitechainSepolia.id };
}
