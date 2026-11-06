import { decodeFunctionResult, encodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { mandateModuleAbi } from './abi/MandateModule.ts';
import type { Approval } from './payment.ts';
import { config } from './config.ts';
import { configV2 } from './config-v2.ts';
import { isV2Account } from './pay-v2.ts';
import { ethCall } from './rpc.ts';

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

/** EIP-712 digest; MandateModule v1 signs domain version '1', MandateModuleV2 version '2'. */
export const mandateDigest = (m: Mandate, mandateModule: Address, chainId: number, version: '1' | '2' = '1'): Hex =>
  hashTypedData({
    domain: { name: 'Tazor', version, chainId, verifyingContract: mandateModule },
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

/** Which MandateModule a company uses: MandateModuleV2 for v2 companies (configured on PaymentModuleV2), else v1. */
export type MandateModuleRef = { address: Address; version: '1' | '2' };

export async function mandateModuleFor(account: Address, v2 = isV2Account): Promise<MandateModuleRef | null> {
  if (configV2.mandateModule && (await v2(account))) return { address: configV2.mandateModule, version: '2' };
  return config.mandateModule ? { address: config.mandateModule, version: '1' } : null;
}

/** Finds the module holding a mandate id (v2 first, then v1) with its state; null if neither knows it. */
export async function findMandate(id: Hex, call: typeof ethCall = ethCall) {
  const refs: MandateModuleRef[] = [];
  if (configV2.mandateModule) refs.push({ address: configV2.mandateModule, version: '2' });
  if (config.mandateModule) refs.push({ address: config.mandateModule, version: '1' });
  for (const ref of refs) {
    try {
      const state = decodeMandateOf(await call(ref.address, encodeMandateOfCall(id)));
      if (state.account !== '0x0000000000000000000000000000000000000000') return { ref, state };
    } catch { /* not on this module */ }
  }
  return null;
}
