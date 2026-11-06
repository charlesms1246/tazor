import {
  decodeFunctionResult, encodeFunctionData, getAddress, isHex, type Address, type Hex,
} from 'viem';
import { paymentModuleAbi } from './abi/PaymentModule.ts';
import { invoiceHash, type Invoice } from './invoice.ts';
import type { InvoiceAuth } from './invoice-auth.ts';

export const AUTH_VALIDITY_AFTER_DUE = 30n * 24n * 3600n;

export function defaultAuthParams(invoice: Invoice): { nonce: bigint; expiry: bigint } {
  return { nonce: BigInt(invoiceHash(invoice)), expiry: BigInt(invoice.dueDate) + AUTH_VALIDITY_AFTER_DUE };
}

export const encodeInvoiceDigestCall = (auth: InvoiceAuth): Hex =>
  encodeFunctionData({ abi: paymentModuleAbi, functionName: 'invoiceDigest', args: [auth] });

export const decodeInvoiceDigest = (data: Hex): Hex =>
  decodeFunctionResult({ abi: paymentModuleAbi, functionName: 'invoiceDigest', data });

export type Approval = { approver: Address; signature: Hex };

export const serializeApproval = (a: Approval) => JSON.stringify({ approver: a.approver, signature: a.signature });

export function parseApprovals(text: string): Approval[] {
  const raw: unknown = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v, i) => {
    const o = v as Record<string, unknown>;
    if (typeof o?.approver !== 'string' || typeof o?.signature !== 'string' || !isHex(o.signature)) {
      throw new Error(`approval ${i} must be {approver, signature}`);
    }
    return { approver: getAddress(o.approver), signature: o.signature };
  });
}

export function mergeApprovals(...groups: Approval[][]): Approval[] {
  const seen = new Map<string, Approval>();
  for (const a of groups.flat()) seen.set(a.approver.toLowerCase(), a);
  return [...seen.values()];
}

export const encodePayOne = (auth: InvoiceAuth, approvals: Approval[]): Hex =>
  encodeFunctionData({
    abi: paymentModuleAbi,
    functionName: 'payOne',
    args: [auth.account, auth, approvals.map((a) => a.approver), approvals.map((a) => a.signature)],
  });

export const relayerBody = (auth: InvoiceAuth, approvals: Approval[]) => ({
  account: auth.account,
  auth: { ...auth, amount: auth.amount.toString(), expiry: auth.expiry.toString(), nonce: auth.nonce.toString() },
  approvers: approvals.map((a) => a.approver),
  signatures: approvals.map((a) => a.signature),
});
