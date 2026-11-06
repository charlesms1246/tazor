import { isAddress, type Address } from 'viem';

const addr = (v: string | undefined, fallback: Address): Address | null => (v === undefined || v === '' ? fallback : isAddress(v) ? v : null);

export const config = {
  chainId: 1874,
  rpcUrl: process.env.NEXT_PUBLIC_WC_RPC || 'https://rpc.testnet.whitechain.io',
  explorer: 'https://explorer.testnet.whitechain.io',
  relayerUrl: (process.env.NEXT_PUBLIC_RELAYER_URL ?? 'https://tazor-relayer.vercel.app').replace(/\/+$/, ''),
  paymentModule: addr(process.env.NEXT_PUBLIC_PAYMENT_MODULE, '0xe19ddf1fd417B146137A5dE6eb56c4589431540A'),
  approverAccountFactory: addr(process.env.NEXT_PUBLIC_APPROVER_ACCOUNT_FACTORY, '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e'),
  tazorAccountFactory: addr(process.env.NEXT_PUBLIC_TAZOR_ACCOUNT_FACTORY, '0xe6efb87a9f3C2d7275aDB9526094Fc7aa4d5b4A2'),
  roleCache: addr(process.env.NEXT_PUBLIC_ROLE_CACHE, '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe'),
  mandateModule: addr(process.env.NEXT_PUBLIC_MANDATE_MODULE, '0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32'),
  wbSoulMirror: addr(process.env.NEXT_PUBLIC_WB_SOUL, '0x9822650A99bD33F29E383345F570dAE1e4E00928'),
  entryPoint: addr(process.env.NEXT_PUBLIC_ENTRY_POINT, '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'),
  revocationList: addr(process.env.NEXT_PUBLIC_REVOCATION_LIST, '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e'),
  /** TazorCheckout (gasless checkout, refunds, subscriptions), deployed at Whitechain Sepolia block 12391780. */
  checkout: addr(process.env.NEXT_PUBLIC_CHECKOUT, '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670'),
  /** TazorDepositCheckout: the customer pays by a plain USDT transfer to a per-order address (e.g. an exchange withdrawal). */
  depositCheckout: addr(process.env.NEXT_PUBLIC_DEPOSIT_CHECKOUT, '0xcb3515398C8Cd9459a1Dce75aB42ec664a07B3ab'),
  sepolia: {
    chainId: 11155111,
    rpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    ensGate: addr(process.env.NEXT_PUBLIC_ENS_GATE, '0x3fDFaeFe793F05BB22FA58AB44eE294E51B26c2a'),
  },
};
