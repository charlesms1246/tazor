import {
  decodeFunctionData, getAddress, isAddressEqual, isErc6492Signature, parseErc6492Signature,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { approverFactoryAbi } from './approver.ts';
import { BadRequest } from './payment.ts';

export type Deploy = { to: Address; data: Hex };

/**
 * ERC-6492 approvals from approvers whose ApproverAccount is not deployed yet.
 * A wrapped signature is accepted only if its factory is the configured ApproverAccountFactory, its calldata is
 * createAccount(signers), and predictAddress(signers) equals the claimed approver. Before anything is sent, the
 * wrapped signature is verified against `digest` with an eth_call (viem's universal ERC-6492 validator), so a bad
 * signature costs the relayer no deploy gas.
 * Returns the inner signatures (what PaymentModule checks via ERC-1271 once deployed) and the deploys to send first.
 */
export async function resolveCounterfactual(
  client: PublicClient,
  factory: Address,
  approvers: Address[],
  signatures: Hex[],
  digest: () => Promise<Hex>,
): Promise<{ signatures: Hex[]; deploys: Deploy[] }> {
  const out: Hex[] = [];
  const deploys: Deploy[] = [];
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    if (!isErc6492Signature(sig)) { out.push(sig); continue; }
    const { address, data, signature } = parseErc6492Signature(sig);
    if (!address || !data || !isAddressEqual(address, factory)) throw new BadRequest(`signatures[${i}]: ERC-6492 factory must be ${factory}`);
    let signers: readonly Hex[];
    try {
      const call = decodeFunctionData({ abi: approverFactoryAbi, data });
      if (call.functionName !== 'createAccount') throw new Error();
      signers = call.args[0] as readonly Hex[];
    } catch {
      throw new BadRequest(`signatures[${i}]: ERC-6492 factory calldata must be createAccount(bytes[])`);
    }
    const predicted = await client.readContract({ address: factory, abi: approverFactoryAbi, functionName: 'predictAddress', args: [signers] });
    if (!isAddressEqual(predicted, approvers[i])) throw new BadRequest(`signatures[${i}]: ERC-6492 account ${predicted} is not approvers[${i}]`);
    const deployed = ((await client.getCode({ address: approvers[i] })) ?? '0x') !== '0x';
    if (!deployed) {
      const ok = await client.verifyHash({ address: approvers[i], hash: await digest(), signature: sig });
      if (!ok) throw new BadRequest(`signatures[${i}]: ERC-6492 signature does not verify for ${approvers[i]}`);
      if (!deploys.some((d) => d.data === data)) deploys.push({ to: getAddress(factory), data });
    }
    out.push(signature);
  }
  return { signatures: out, deploys };
}
