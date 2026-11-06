/**
 * Adds an ordinary wallet (ECDSA) as a backup signer of this device's approver account, through a userOp the
 * WB Soul paymaster sponsors and the passkey signs. Same steps as the Company page's backup signer card.
 */
import { getAddress, type Address, type Hex } from 'viem';
import { backupSigner, signDigestWithPasskey } from './approver-signature.ts';
import { config } from './config.ts';
import { getRelayerUrl } from './relayer-url.ts';
import { ethCall, rpc } from './rpc.ts';
import type { StoredPasskey } from './storage.ts';
import {
  GAS_DEFAULTS, addSignersCallData, applyPaymasterResult, decodeGetUserOpHash, decodeIsSigner, encodeGetNonce,
  encodeGetUserOpHash, encodeIsSigner, relayerRpc, submitUserOp, toRpcUserOp, type UserOp,
} from './userop.ts';

/** The message a person signs with the backup wallet to prove they control it. */
export const backupProofMessage = (approver: string, wallet: string, at: Date) =>
  `Tazor: use ${getAddress(wallet)} as the backup key of approver account ${getAddress(approver)}.\n\nSigning this costs nothing and sends no transaction.\n${at.toISOString()}`;

export async function isBackupSigner(approver: Address, wallet: Address): Promise<boolean> {
  return decodeIsSigner(await ethCall(approver, encodeIsSigner(backupSigner(getAddress(wallet)))));
}

/** Submits the sponsored userOp; returns its transaction hash. Throws a plain-English error. */
export async function addBackupSigner(key: StoredPasskey, wallet: Address, onStep: (s: string) => void = () => {}): Promise<Hex> {
  const relayerUrl = getRelayerUrl();
  if (!relayerUrl) throw new Error('No relayer is set on this device; choose one on Security & settings.');
  const ep = config.entryPoint;
  if (!ep) throw new Error('EntryPoint address is not configured.');
  const sender = key.approverAccount as Address;
  const signer = backupSigner(getAddress(wallet));
  onStep('Checking your approver account…');
  if (((await rpc<Hex>('eth_getCode', [sender, 'latest'])) ?? '0x') === '0x') throw new Error('Your approver account is not on Whitechain yet; finish the steps above first.');
  if (decodeIsSigner(await ethCall(sender, encodeIsSigner(signer)))) throw new Error('This wallet is already your backup key.');
  const [nonceHex, gasPriceHex] = await Promise.all([ethCall(ep, encodeGetNonce(sender)), rpc<Hex>('eth_gasPrice', [])]);
  const gasPrice = BigInt(gasPriceHex);
  let op: UserOp = {
    sender, nonce: BigInt(nonceHex), callData: addSignersCallData(sender, [signer]),
    callGasLimit: GAS_DEFAULTS.callGasLimit, verificationGasLimit: GAS_DEFAULTS.verificationGasLimit,
    preVerificationGas: GAS_DEFAULTS.preVerificationGas, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice,
    paymasterVerificationGasLimit: GAS_DEFAULTS.paymasterVerificationGasLimit, paymasterPostOpGasLimit: GAS_DEFAULTS.paymasterPostOpGasLimit,
    signature: '0x',
  };
  const chainId = `0x${config.chainId.toString(16)}`;
  onStep('Asking the sponsor (WB Soul quota), so this costs you nothing…');
  op = applyPaymasterResult(op, await relayerRpc(relayerUrl, 'pm_getPaymasterStubData', [toRpcUserOp(op), ep, chainId, {}]));
  op = applyPaymasterResult(op, await relayerRpc(relayerUrl, 'pm_getPaymasterData', [toRpcUserOp(op), ep, chainId, {}]));
  onStep('Confirm with your passkey (Face ID, fingerprint or device PIN)…');
  const userOpHash = decodeGetUserOpHash(await ethCall(ep, encodeGetUserOpHash(op)));
  op = { ...op, signature: await signDigestWithPasskey(key.credentialId, userOpHash, key) };
  onStep('Submitting…');
  return submitUserOp(relayerUrl, op);
}
