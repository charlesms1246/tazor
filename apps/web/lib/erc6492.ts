import {
  encodeFunctionData, isErc6492Signature, parseAbi, parseErc6492Signature, serializeErc6492Signature,
  type Address, type Hex,
} from 'viem';
import { passkeySigner } from './approver-signature.ts';
import { config } from './config.ts';
import { rpc } from './rpc.ts';

export const ERC6492_MAGIC: Hex = '0x6492649264926492649264926492649264926492649264926492649264926492';
const factoryAbi = parseAbi(['function createAccount(bytes[] signers) returns (address)']);

export const createAccountCalldata = (signers: Hex[]): Hex =>
  encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [signers] });

/** abi.encode(factory, factoryCalldata, innerSignature) ++ magic. */
export const wrap6492 = (factory: Address, factoryCalldata: Hex, inner: Hex): Hex =>
  serializeErc6492Signature({ address: factory, data: factoryCalldata, signature: inner });

export const isWrapped6492 = (sig: Hex): boolean => isErc6492Signature(sig);

/** The inner (deployed-account) signature; unwrapped signatures pass through. */
export const unwrap6492 = (sig: Hex): { inner: Hex; factory?: Address; factoryCalldata?: Hex } => {
  if (!isErc6492Signature(sig)) return { inner: sig };
  const p = parseErc6492Signature(sig);
  return { inner: p.signature, factory: p.address, factoryCalldata: p.data };
};

export const isDeployed = async (account: Address): Promise<boolean> =>
  (await rpc<Hex>('eth_getCode', [account, 'latest'])) !== '0x';

/**
 * For the device's passkey ApproverAccount: wraps the approval per ERC-6492 if the account is not deployed yet,
 * so a relayer can deploy it (createAccount([passkey signer id])) and then pay with the inner signature.
 */
export async function counterfactualApproval(
  key: { approverAccount: Address; verifier: Address; x: Hex; y: Hex },
  approval: Hex,
): Promise<Hex> {
  if (!config.approverAccountFactory || (await isDeployed(key.approverAccount))) return approval;
  return wrap6492(config.approverAccountFactory, createAccountCalldata([passkeySigner(key.verifier, key.x, key.y)]), approval);
}
