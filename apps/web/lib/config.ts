import { isAddress, type Address } from 'viem';

const addr = (v: string | undefined, fallback: Address): Address | null => (v === undefined || v === '' ? fallback : isAddress(v) ? v : null);

export const config = {
  chainId: 1874,
  rpcUrl: process.env.NEXT_PUBLIC_WC_RPC || 'https://rpc.testnet.whitechain.io',
  explorer: 'https://explorer.testnet.whitechain.io',
  relayerUrl: (process.env.NEXT_PUBLIC_RELAYER_URL ?? '').replace(/\/+$/, ''),
  paymentModule: addr(process.env.NEXT_PUBLIC_PAYMENT_MODULE, '0xe19ddf1fd417B146137A5dE6eb56c4589431540A'),
  approverAccountFactory: addr(process.env.NEXT_PUBLIC_APPROVER_ACCOUNT_FACTORY, '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e'),
  tazorAccountFactory: addr(process.env.NEXT_PUBLIC_TAZOR_ACCOUNT_FACTORY, '0xe6efb87a9f3C2d7275aDB9526094Fc7aa4d5b4A2'),
  roleCache: addr(process.env.NEXT_PUBLIC_ROLE_CACHE, '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe'),
  revocationList: addr(process.env.NEXT_PUBLIC_REVOCATION_LIST, '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e'),
};
