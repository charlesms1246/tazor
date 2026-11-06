import { decodeFunctionResult, encodeFunctionData, hashStruct, hashTypedData, type Address, type Hex } from 'viem';
import { paymentModuleV2Abi } from './abi/PaymentModuleV2.ts';
import { invoiceAuthTypes, type InvoiceAuth } from './invoice-auth.ts';

export const ROLE_APPROVER = 1n << 64n;
export const ROLE_TAZOR_ADMIN = 1n << 68n;
export const ROLE_AGENT = 1n << 72n;
export const MAX_GRANT_SECONDS = 600n;

export type V2Domain = { chainId: number; verifyingContract: Address };
const domain = (d: V2Domain) => ({ name: 'Tazor', version: '2', chainId: d.chainId, verifyingContract: d.verifyingContract });

export const policyTypes = {
  AddPayee: [
    { name: 'account', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
  ProvisionalGrant: [
    { name: 'account', type: 'address' },
    { name: 'grantee', type: 'address' },
    { name: 'roles', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'deadline', type: 'uint256' },
  ],
  ApproverExpiry: [
    { name: 'account', type: 'address' },
    { name: 'approver', type: 'address' },
    { name: 'until', type: 'uint64' },
    { name: 'deadline', type: 'uint256' },
  ],
  RequestExit: [
    { name: 'account', type: 'address' },
    { name: 'exitIndex', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  CancelExit: [
    { name: 'account', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type PolicyMessage =
  | { type: 'AddPayee'; message: { account: Address; payee: Address; deadline: bigint } }
  | { type: 'ProvisionalGrant'; message: { account: Address; grantee: Address; roles: bigint; validUntil: bigint; deadline: bigint } }
  | { type: 'ApproverExpiry'; message: { account: Address; approver: Address; until: bigint; deadline: bigint } }
  | { type: 'RequestExit'; message: { account: Address; exitIndex: bigint; deadline: bigint } }
  | { type: 'CancelExit'; message: { account: Address; deadline: bigint } };

const one = <T extends PolicyMessage['type']>(t: T) => ({ [t]: policyTypes[t] }) as { [K in T]: (typeof policyTypes)[K] };

/** Struct hash passed to PaymentModuleV2.typedDigest. */
export const policyStructHash = (m: PolicyMessage): Hex =>
  hashStruct({ data: m.message, primaryType: m.type, types: one(m.type) } as never);

/** Local EIP-712 digest; must equal PaymentModuleV2.typedDigest(policyStructHash(m)). */
export const policyDigest = (m: PolicyMessage, d: V2Domain): Hex =>
  hashTypedData({ domain: domain(d), types: one(m.type), primaryType: m.type, message: m.message } as never);

export const invoiceAuthDigestV2 = (auth: InvoiceAuth, d: V2Domain): Hex =>
  hashTypedData({ domain: domain(d), types: invoiceAuthTypes, primaryType: 'InvoiceAuth', message: auth });

// ---- calls

const fn = (functionName: string, args: readonly unknown[] = []) =>
  encodeFunctionData({ abi: paymentModuleV2Abi, functionName, args } as never);
const dec = <T>(functionName: string, data: Hex) =>
  decodeFunctionResult({ abi: paymentModuleV2Abi, functionName, data } as never) as T;

export type ConfigV2 = {
  registry: Address;
  twoApproverThreshold: bigint;
  perPaymentLimit: bigint;
  monthlyLimit: bigint;
  payeeDelay: number;
  freshThreshold: bigint;
  maxCacheAge: number;
  agentMonthlyCap: bigint;
  exitAccounts: readonly Address[];
  exitDelay: number;
};

export const encodeConfigV2Of = (account: Address) => fn('configV2Of', [account]);
export const decodeConfigV2 = (data: Hex) => dec<ConfigV2>('configV2Of', data);
export const encodeWindowAvailable = (account: Address) => fn('windowAvailable', [account]);
export const decodeWindowAvailable = (data: Hex) => dec<readonly [bigint, bigint]>('windowAvailable', data);
export const encodePayeeAddedAt = (account: Address, payee: Address) => fn('payeeAddedAt', [account, payee]);
export const decodePayeeAddedAt = (data: Hex) => dec<bigint>('payeeAddedAt', data);
export const encodePendingExit = (account: Address) => fn('pendingExit', [account]);
export const decodePendingExit = (data: Hex) => dec<readonly [Address, bigint]>('pendingExit', data);
export const encodeTypedDigest = (structHash: Hex) => fn('typedDigest', [structHash]);
export const decodeTypedDigest = (data: Hex) => dec<Hex>('typedDigest', data);
export const encodeInvoiceDigestV2 = (auth: InvoiceAuth) => fn('invoiceDigest', [auth]);
export const decodeInvoiceDigestV2 = (data: Hex) => dec<Hex>('invoiceDigest', data);
export const encodeApproverStatus = (account: Address, approver: Address) => fn('approverStatus', [account, approver]);
export const decodeApproverStatus = (data: Hex) => dec<readonly [bigint, boolean]>('approverStatus', data);

/** Calldata for the signed policy action (sender: anyone). */
export function encodePolicyCall(m: PolicyMessage, signer: Address, sig: Hex): Hex {
  const x = m.message as unknown as Record<string, never>;
  switch (m.type) {
    case 'AddPayee': return fn('addPayee', [x.account, x.payee, signer, x.deadline, sig]);
    case 'ProvisionalGrant': return fn('provisionalGrant', [x.account, x.grantee, x.roles, x.validUntil, signer, x.deadline, sig]);
    case 'ApproverExpiry': return fn('setApproverExpiry', [x.account, x.approver, x.until, signer, x.deadline, sig]);
    case 'RequestExit': return fn('requestExit', [x.account, x.exitIndex, signer, x.deadline, sig]);
    case 'CancelExit': return fn('cancelExit', [x.account, signer, x.deadline, sig]);
  }
}

export const encodeExecuteExit = (account: Address) => fn('executeExit', [account]);

export const encodePayOneV2 = (auth: InvoiceAuth, approvals: { approver: Address; signature: Hex }[]) =>
  fn('payOne', [auth.account, auth, approvals.map((a) => a.approver), approvals.map((a) => a.signature)]);

export const encodePayAsAgent = (auth: InvoiceAuth, agent: Address, signature: Hex) =>
  fn('payAsAgent', [auth.account, auth, agent, signature]);
