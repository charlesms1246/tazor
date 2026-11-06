import { decodeFunctionResult, encodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { revocationListAbi } from './abi/RevocationList.ts';

export type Revoke = { account: Address; target: Address; deadline: bigint };

export const revokeTypes = {
  Revoke: [
    { name: 'account', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const revokeDigest = (r: Revoke, revocationList: Address, chainId: number): Hex =>
  hashTypedData({
    domain: { name: 'Tazor', version: '1', chainId, verifyingContract: revocationList },
    types: revokeTypes,
    primaryType: 'Revoke',
    message: r,
  });

export const encodeRevokeDigestCall = (r: Revoke): Hex =>
  encodeFunctionData({ abi: revocationListAbi, functionName: 'revokeDigest', args: [r.account, r.target, r.deadline] });

export const decodeRevokeDigest = (data: Hex): Hex =>
  decodeFunctionResult({ abi: revocationListAbi, functionName: 'revokeDigest', data });

export const encodeIsRevokedCall = (account: Address, target: Address): Hex =>
  encodeFunctionData({ abi: revocationListAbi, functionName: 'isRevoked', args: [account, target] });

export const decodeIsRevoked = (data: Hex): boolean =>
  decodeFunctionResult({ abi: revocationListAbi, functionName: 'isRevoked', data });

export const revokeRelayerBody = (r: Revoke, admin: Address, sig: Hex) => ({
  account: r.account, target: r.target, admin, deadline: r.deadline.toString(), sig,
});
