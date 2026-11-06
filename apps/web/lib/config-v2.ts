import { isAddress, type Address } from 'viem';

const addr = (v: string | undefined, fallback: Address): Address | null => (v === undefined || v === '' ? fallback : isAddress(v) ? v : null);

/** v2 contracts (Whitechain Sepolia), alongside the v1 addresses in config.ts. */
export const configV2 = {
  paymentModule: addr(process.env.NEXT_PUBLIC_PAYMENT_MODULE_V2, '0x906620D82e2959351c81D731C67EA46DF71E36f3'),
  mandateModule: addr(process.env.NEXT_PUBLIC_MANDATE_MODULE_V2, '0x24b6eC6f6bf7e58bB3266b0b2701aE451ab7220F'),
  revocationList: addr(process.env.NEXT_PUBLIC_REVOCATION_LIST_V2, '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a'),
  ensGateV2: addr(process.env.NEXT_PUBLIC_ENS_GATE_V2, '0xF7EB3B7E8295914eeaFc44aC26811DA03B41B656'),
  usdt: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as Address,
  demoAccount: '0xb99A12652BEe98429ae31EA0529A0b63f1073721' as Address,
  domainVersion: '2',
};
