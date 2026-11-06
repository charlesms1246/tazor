import { isAddress, type Address } from 'viem';

const addr = (v: string | undefined): Address | null => (v && isAddress(v) ? v : null);

export const config = {
  chainId: 1874,
  rpcUrl: process.env.NEXT_PUBLIC_WC_RPC || 'https://rpc.testnet.whitechain.io',
  explorer: 'https://explorer.testnet.whitechain.io',
  relayerUrl: (process.env.NEXT_PUBLIC_RELAYER_URL ?? '').replace(/\/+$/, ''),
  paymentModule: addr(process.env.NEXT_PUBLIC_PAYMENT_MODULE),
  approverAccountFactory: addr(process.env.NEXT_PUBLIC_APPROVER_ACCOUNT_FACTORY),
  tazorAccountFactory: addr(process.env.NEXT_PUBLIC_TAZOR_ACCOUNT_FACTORY),
  revocationList: addr(process.env.NEXT_PUBLIC_REVOCATION_LIST),
};
