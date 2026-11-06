import { getAddress, hashTypedData, hashStruct, isAddressEqual, type Address, type Hex } from 'viem';
import { invoiceHash, parseInvoice, type Invoice } from './invoice.ts';

export const WHITECHAIN_SEPOLIA_USDT: Address = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const UINT64_MAX = (1n << 64n) - 1n;

export type InvoiceAuth = {
  invoiceHash: Hex;
  account: Address;
  payee: Address;
  amount: bigint;
  expiry: bigint;
  nonce: bigint;
};

export type TazorDomain = { chainId: number; verifyingContract: Address };

export const invoiceAuthTypes = {
  InvoiceAuth: [
    { name: 'invoiceHash', type: 'bytes32' },
    { name: 'account', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function buildInvoiceAuth(linkInvoice: Invoice, nonce: bigint, expiry: bigint): InvoiceAuth {
  const invoice = parseInvoice(linkInvoice);
  if (!isAddressEqual(invoice.token, WHITECHAIN_SEPOLIA_USDT)) throw new Error('invoice token is not USDT');
  if (nonce < 0n) throw new Error('nonce must be non-negative');
  if (expiry < 0n || expiry > UINT64_MAX) throw new Error('expiry must fit uint64');
  return {
    invoiceHash: invoiceHash(invoice),
    account: invoice.buyerAccount,
    payee: invoice.payee,
    amount: invoice.amount,
    expiry,
    nonce,
  };
}

export function invoiceAuthTypedData(auth: InvoiceAuth, domain: TazorDomain) {
  return {
    domain: { name: 'Tazor', version: '1', chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    types: invoiceAuthTypes,
    primaryType: 'InvoiceAuth' as const,
    message: auth,
  };
}

export const invoiceAuthStructHash = (auth: InvoiceAuth): Hex =>
  hashStruct({ data: auth, primaryType: 'InvoiceAuth', types: invoiceAuthTypes });

export const invoiceAuthDigest = (auth: InvoiceAuth, domain: TazorDomain): Hex =>
  hashTypedData(invoiceAuthTypedData(auth, domain));

export function checkServerValue(serverAuth: InvoiceAuth, linkInvoice: Invoice, nonce: bigint, expiry: bigint): string[] {
  const expected = buildInvoiceAuth(linkInvoice, nonce, expiry);
  const mismatches: string[] = [];
  const same = (k: keyof InvoiceAuth) => {
    const a = serverAuth[k];
    const b = expected[k];
    if (k === 'account' || k === 'payee') {
      try { return getAddress(a as string) === b; } catch { return false; }
    }
    if (k === 'invoiceHash') return typeof a === 'string' && a.toLowerCase() === (b as string).toLowerCase();
    return typeof a === 'bigint' && a === b;
  };
  for (const k of Object.keys(expected) as (keyof InvoiceAuth)[]) {
    if (!same(k)) mismatches.push(`${k}: server ${String(serverAuth[k])}, link ${String(expected[k])}`);
  }
  return mismatches;
}
