import type { Address, Hex } from 'viem';
import { canonicalInvoiceJson, parseInvoice } from './invoice.ts';
import type { PaymentRecord } from './export.ts';

export type StoredPasskey = { credentialId: string; x: Hex; y: Hex; verifier: Address; approverAccount: Address };

const KEY = 'tazor.passkey.v1';

export function loadPasskey(): StoredPasskey | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as StoredPasskey) : null;
  } catch {
    return null;
  }
}

export function savePasskey(p: StoredPasskey): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

const PAYMENTS = 'tazor.payments.v1';
type StoredPayment = { invoice: string; txHash: Hex; blockTimestamp: number };

export function loadPayments(): PaymentRecord[] {
  try {
    const list = JSON.parse(localStorage.getItem(PAYMENTS) ?? '[]') as StoredPayment[];
    return list.map((p) => ({ invoice: parseInvoice(JSON.parse(p.invoice)), txHash: p.txHash, blockTimestamp: p.blockTimestamp }));
  } catch {
    return [];
  }
}

export function appendPayment(p: PaymentRecord): boolean {
  try {
    const list = JSON.parse(localStorage.getItem(PAYMENTS) ?? '[]') as StoredPayment[];
    if (!list.some((x) => x.txHash === p.txHash)) {
      list.push({ invoice: canonicalInvoiceJson(p.invoice), txHash: p.txHash, blockTimestamp: p.blockTimestamp });
    }
    localStorage.setItem(PAYMENTS, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
