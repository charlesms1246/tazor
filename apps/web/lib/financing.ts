import { decodeFunctionResult, encodeFunctionData, erc20Abi, hashTypedData, type Address, type Hex } from 'viem';
import { financingModuleAbi } from './abi/FinancingModule.ts';

export type FinancedInvoice = {
  invoiceHash: Hex;
  account: Address;
  holder: Address;
  amount: bigint;
  dueDate: bigint;
  nonce: bigint;
};

export const financedTypes = {
  FinancedInvoice: [
    { name: 'invoiceHash', type: 'bytes32' },
    { name: 'account', type: 'address' },
    { name: 'holder', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'dueDate', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Local EIP-712 digest; must equal FinancingModule.financedDigest(f). Its uint256 value is the claim id. */
export const financedDigest = (f: FinancedInvoice, d: { chainId: number; verifyingContract: Address }): Hex =>
  hashTypedData({
    domain: { name: 'Tazor', version: '2', chainId: d.chainId, verifyingContract: d.verifyingContract },
    types: financedTypes,
    primaryType: 'FinancedInvoice',
    message: f,
  });

export const claimId = (digest: Hex): bigint => BigInt(digest);

const fn = (functionName: string, args: readonly unknown[] = []) =>
  encodeFunctionData({ abi: financingModuleAbi, functionName, args } as never);
const dec = <T>(functionName: string, data: Hex) =>
  decodeFunctionResult({ abi: financingModuleAbi, functionName, data } as never) as T;

export const encodeFinancedDigest = (f: FinancedInvoice) => fn('financedDigest', [f]);
export const decodeFinancedDigest = (data: Hex) => dec<Hex>('financedDigest', data);
export const encodeCommit = (f: FinancedInvoice, approvals: { approver: Address; signature: Hex }[]) =>
  fn('commit', [f, approvals.map((a) => a.approver), approvals.map((a) => a.signature)]);
export const encodeList = (id: bigint, price: bigint) => fn('list', [id, price]);
export const encodeBuy = (id: bigint) => fn('buy', [id]);
export const encodeSettle = (id: bigint) => fn('settle', [id]);
export const encodeApproveUsdt = (spender: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

export const encodeOwnerOf = (id: bigint) => fn('ownerOf', [id]);
export const decodeOwnerOf = (data: Hex) => dec<Address>('ownerOf', data);
export const encodeClaims = (id: bigint) => fn('claims', [id]);
export const decodeClaims = (data: Hex) => dec<readonly [Address, bigint, bigint]>('claims', data);
export const encodeListings = (id: bigint) => fn('listings', [id]);
export const decodeListings = (data: Hex) => dec<bigint>('listings', data);
