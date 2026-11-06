import { decodeFunctionResult, encodeFunctionData, hashTypedData, parseAbi, type Address, type Hex } from 'viem';
import { invoiceAuthStructHash, type InvoiceAuth } from './invoice-auth.ts';

const runAbi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function payRun(address account, InvoiceAuth[] auths, address[] approvers, bytes[] signatures)',
  'function runDigest(InvoiceAuth[] auths) view returns (bytes32)',
]);

/** Local EIP-712 PaymentRun digest; v1 = domain version "1" on PaymentModule, v2 = "2" on PaymentModuleV2. */
export const runDigest = (auths: InvoiceAuth[], d: { chainId: number; verifyingContract: Address; version: '1' | '2' }): Hex =>
  hashTypedData({
    domain: { name: 'Tazor', version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
    types: { PaymentRun: [{ name: 'authHashes', type: 'bytes32[]' }] },
    primaryType: 'PaymentRun',
    message: { authHashes: auths.map(invoiceAuthStructHash) },
  });

export const encodeRunDigestCall = (auths: InvoiceAuth[]): Hex => encodeFunctionData({ abi: runAbi, functionName: 'runDigest', args: [auths] });
export const decodeRunDigest = (data: Hex): Hex => decodeFunctionResult({ abi: runAbi, functionName: 'runDigest', data });

export const encodePayRun = (account: Address, auths: InvoiceAuth[], approvals: { approver: Address; signature: Hex }[]): Hex =>
  encodeFunctionData({ abi: runAbi, functionName: 'payRun', args: [account, auths, approvals.map((a) => a.approver), approvals.map((a) => a.signature)] });

const s = (a: InvoiceAuth) => ({ ...a, amount: a.amount.toString(), expiry: a.expiry.toString(), nonce: a.nonce.toString() });
export const payRunRelayerBody = (account: Address, auths: InvoiceAuth[], approvals: { approver: Address; signature: Hex }[]) => ({
  account, auths: auths.map(s), approvers: approvals.map((a) => a.approver), signatures: approvals.map((a) => a.signature),
});
