import { getAddress, keccak256, stringToBytes, type Address, type Hex } from 'viem';

export type InvoiceLine = { description: string; quantity: bigint; unitPrice: bigint };

export type Invoice = {
  id: string;
  supplierName: string;
  supplierAccount: Address;
  payee: Address;
  buyerAccount: Address;
  token: Address;
  amount: bigint;
  dueDate: number;
  lines: InvoiceLine[];
  memo: string;
};

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw new Error(`invoice.${field} must be a string`);
  return v;
};
const addr = (v: unknown, field: string): Address => getAddress(str(v, field));
const uint = (v: unknown, field: string): bigint => {
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) return BigInt(v);
  throw new Error(`invoice.${field} must be a non-negative integer`);
};

export function parseInvoice(raw: unknown): Invoice {
  if (typeof raw !== 'object' || raw === null) throw new Error('invoice must be an object');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.lines) || o.lines.length === 0) throw new Error('invoice.lines must be a non-empty array');
  const dueDate = o.dueDate;
  if (typeof dueDate !== 'number' || !Number.isSafeInteger(dueDate) || dueDate < 0) {
    throw new Error('invoice.dueDate must be unix seconds');
  }
  const invoice: Invoice = {
    id: str(o.id, 'id'),
    supplierName: str(o.supplierName, 'supplierName'),
    supplierAccount: addr(o.supplierAccount, 'supplierAccount'),
    payee: addr(o.payee, 'payee'),
    buyerAccount: addr(o.buyerAccount, 'buyerAccount'),
    token: addr(o.token, 'token'),
    amount: uint(o.amount, 'amount'),
    dueDate,
    lines: o.lines.map((l: Record<string, unknown>, i: number) => ({
      description: str(l?.description, `lines[${i}].description`),
      quantity: uint(l?.quantity, `lines[${i}].quantity`),
      unitPrice: uint(l?.unitPrice, `lines[${i}].unitPrice`),
    })),
    memo: str(o.memo, 'memo'),
  };
  const total = invoice.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0n);
  if (total !== invoice.amount) throw new Error(`invoice lines sum to ${total}, amount is ${invoice.amount}`);
  return invoice;
}

export function canonicalInvoiceJson(input: Invoice): string {
  const i = parseInvoice(input);
  return JSON.stringify({
    id: i.id,
    supplierName: i.supplierName,
    supplierAccount: i.supplierAccount,
    payee: i.payee,
    buyerAccount: i.buyerAccount,
    token: i.token,
    amount: i.amount.toString(),
    dueDate: i.dueDate,
    lines: i.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
    })),
    memo: i.memo,
  });
}

export const invoiceHash = (invoice: Invoice): Hex => keccak256(stringToBytes(canonicalInvoiceJson(invoice)));
