import { type Address, type Hex } from 'viem';
import { configV2 } from './config-v2.ts';
import { ethCall } from './rpc.ts';
import { decodeConfigV2, encodeConfigV2Of, encodePayAsAgent, encodePayOneV2, invoiceAuthDigestV2 } from './policies.ts';
import type { InvoiceAuth } from './invoice-auth.ts';

/** True if `account` is configured on PaymentModuleV2 (a v2 company). */
export async function isV2Account(account: Address): Promise<boolean> {
  const pm = configV2.paymentModule;
  if (!pm) return false;
  try {
    return decodeConfigV2(await ethCall(pm, encodeConfigV2Of(account))).registry !== '0x0000000000000000000000000000000000000000';
  } catch {
    return false;
  }
}

export const v2Digest = (auth: InvoiceAuth, chainId: number): Hex =>
  invoiceAuthDigestV2(auth, { chainId, verifyingContract: configV2.paymentModule! });

export { encodePayAsAgent, encodePayOneV2 };
