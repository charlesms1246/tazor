import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { approverAccountFactoryAbi } from './abi/ApproverAccountFactory.ts';
import { passkeySigner } from './approver-signature.ts';
import { ethCall } from './rpc.ts';

export async function webAuthnVerifier(factory: Address): Promise<Address> {
  const data = await ethCall(factory, encodeFunctionData({ abi: approverAccountFactoryAbi, functionName: 'webAuthnVerifier' }));
  return decodeFunctionResult({ abi: approverAccountFactoryAbi, functionName: 'webAuthnVerifier', data });
}

export async function predictApproverAccount(factory: Address, x: Hex, y: Hex) {
  const verifier = await webAuthnVerifier(factory);
  const signer = passkeySigner(verifier, x, y);
  const data = await ethCall(factory, encodeFunctionData({ abi: approverAccountFactoryAbi, functionName: 'predictAddress', args: [[signer]] }));
  const account = decodeFunctionResult({ abi: approverAccountFactoryAbi, functionName: 'predictAddress', data });
  return { verifier, signer, account };
}
