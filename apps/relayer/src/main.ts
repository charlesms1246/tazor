import { createServer } from 'node:http';
import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { createHandler } from './app.ts';
import { createApproverDeployer } from './approver.ts';
import { createSender } from './sender.ts';

const rpcUrl = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const whitechainSepolia = defineChain({
  id: Number(process.env.CHAIN_ID ?? 1874),
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const paymentModule = getAddress(process.env.PAYMENT_MODULE || '0xe19ddf1fd417B146137A5dE6eb56c4589431540A');
const approverFactory = getAddress(process.env.APPROVER_ACCOUNT_FACTORY || '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e');
const revocationList = getAddress(process.env.REVOCATION_LIST || '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e');
const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
const sender = key ? createSender({ rpcUrl, chain: whitechainSepolia, privateKey: key }) : undefined;
const client = createPublicClient({ chain: whitechainSepolia, transport: http(rpcUrl) });
const approvers = createApproverDeployer(client, approverFactory);
const port = Number(process.env.PORT ?? 8787);

createServer(createHandler({ sender, paymentModule, approvers, revocationList })).listen(port, '0.0.0.0', () => {
  console.log(`relayer on :${port} chain ${whitechainSepolia.id} sender=${sender?.address ?? 'none'} paymentModule=${paymentModule} approverFactory=${approverFactory} revocationList=${revocationList}`);
});
