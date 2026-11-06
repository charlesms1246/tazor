import { decodeFunctionResult, encodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { mandateModuleAbi } from './abi/MandateModule.ts';
import type { Approval } from './payment.ts';

export type Mandate = { account: Address; payee: Address; capPerPeriod: bigint; period: bigint; expiry: bigint; nonce: bigint };

export const PERIODS = { monthly: 2_592_000n, weekly: 604_800n } as const;

export const mandateTypes = {
  Mandate: [
    { name: 'account', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'capPerPeriod', type: 'uint256' },
    { name: 'period', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const mandateDigest = (m: Mandate, mandateModule: Address, chainId: number): Hex =>
  hashTypedData({
    domain: { name: 'Tazor', version: '1', chainId, verifyingContract: mandateModule },
    types: mandateTypes, primaryType: 'Mandate', message: m,
  });

export const encodeMandateDigestCall = (m: Mandate) =>
  encodeFunctionData({ abi: mandateModuleAbi, functionName: 'mandateDigest', args: [m] });
export const decodeMandateDigest = (data: Hex) =>
  decodeFunctionResult({ abi: mandateModuleAbi, functionName: 'mandateDigest', data });

export const encodeCreateMandate = (m: Mandate, approvals: Approval[]) =>
  encodeFunctionData({
    abi: mandateModuleAbi, functionName: 'createMandate',
    args: [m, approvals.map((a) => a.approver), approvals.map((a) => a.signature)],
  });

export const encodePull = (mandateId: Hex, amount: bigint) =>
  encodeFunctionData({ abi: mandateModuleAbi, functionName: 'pull', args: [mandateId, amount] });

export const encodeAvailableCall = (mandateId: Hex) =>
  encodeFunctionData({ abi: mandateModuleAbi, functionName: 'available', args: [mandateId] });
export const decodeAvailable = (data: Hex) =>
  decodeFunctionResult({ abi: mandateModuleAbi, functionName: 'available', data });

export const encodeMandateOfCall = (mandateId: Hex) =>
  encodeFunctionData({ abi: mandateModuleAbi, functionName: 'mandateOf', args: [mandateId] });
export const decodeMandateOf = (data: Hex) =>
  decodeFunctionResult({ abi: mandateModuleAbi, functionName: 'mandateOf', data });

export const mandateRelayerBody = (m: Mandate, approvals: Approval[]) => ({
  mandate: {
    account: m.account, payee: m.payee, capPerPeriod: m.capPerPeriod.toString(), period: m.period.toString(),
    expiry: m.expiry.toString(), nonce: m.nonce.toString(),
  },
  approvers: approvals.map((a) => a.approver),
  signatures: approvals.map((a) => a.signature),
});
