// A wallet kept in this browser's storage, for testnet demos only: no extension and no seed phrase. Never use it for real funds.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { accountSigner, type Signer } from './checkout.ts';

export function demoWallet(storageKey = 'tazor.demo-wallet.v1'): Signer {
  let pk: string | null = null;
  try { pk = globalThis.localStorage?.getItem(storageKey) ?? null; } catch { /* storage blocked */ }
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    pk = generatePrivateKey();
    try { globalThis.localStorage?.setItem(storageKey, pk); } catch { /* a one-off wallet */ }
  }
  return accountSigner(privateKeyToAccount(pk as `0x${string}`));
}
