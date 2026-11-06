import { createServer } from 'node:http';
import { defineChain, getAddress, type Hex } from 'viem';
import { createHandler } from './app.ts';
import { createSender } from './sender.ts';

const rpcUrl = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const whitechainSepolia = defineChain({
  id: 1874,
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const paymentModule = process.env.PAYMENT_MODULE ? getAddress(process.env.PAYMENT_MODULE) : undefined;
const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
const sender = key && paymentModule ? createSender({ rpcUrl, chain: whitechainSepolia, privateKey: key, to: paymentModule }) : undefined;
const port = Number(process.env.PORT ?? 8787);

createServer(createHandler({ sender, paymentModule })).listen(port, '0.0.0.0', () => {
  console.log(`relayer on :${port} chain 1874 sender=${sender?.address ?? 'none'} paymentModule=${paymentModule ?? 'unset'}`);
});
