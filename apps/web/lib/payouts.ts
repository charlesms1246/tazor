/**
 * Paying suppliers from checkout sales. A supplier payout is an ordinary Tazor invoice (supplier → company) that
 * goes into the existing payment run: approved with passkeys, paid by PaymentModule from the company account.
 * Sales land in the checkout merchant's wallet; when that isn't the company account, the company account has to be
 * topped up first. Nothing moves funds automatically.
 */
import { isAddress, isAddressEqual, type Address } from 'viem';
import { buildInvoice, parseUsdt } from './invoices-store.ts';
import type { Invoice } from './invoice.ts';

export type PayoutRow = { address: string; name: string; amount: string };
export type PayoutCheck = { ok: true; total: bigint } | { ok: false; error: string; row: number };

/** Validates the rows (address, a name, a USDT amount); returns the total. */
export function checkPayouts(rows: PayoutRow[]): PayoutCheck {
  if (rows.length === 0) return { ok: false, error: 'Add at least one supplier.', row: -1 };
  let total = 0n;
  for (const [i, r] of rows.entries()) {
    if (!isAddress(r.address.trim())) return { ok: false, error: `Supplier ${i + 1}: enter their Whitechain address (0x…).`, row: i };
    if (!r.name.trim()) return { ok: false, error: `Supplier ${i + 1}: enter a name.`, row: i };
    const a = parseUsdt(r.amount);
    if (a === null || a === 0n) return { ok: false, error: `Supplier ${i + 1}: enter an amount in USDT.`, row: i };
    total += a;
  }
  return { ok: true, total };
}

/** One payout as an invoice the company pays (due today), id PAYOUT-YYYYMMDD-N. */
export function payoutInvoice(company: Address, r: PayoutRow, n: number, now = Date.now()): Invoice {
  const day = new Date(now).toISOString().slice(0, 10);
  const built = buildInvoice({
    customer: company, payee: r.address.trim(), supplierName: r.name.trim(), supplierAccount: '',
    lines: [{ description: 'Supplier payout from sales', quantity: '1', unitPrice: r.amount.trim() }], dueDate: day, memo: 'Paid from checkout sales',
  }, `PAYOUT-${day.replace(/-/g, '')}-${n}`);
  if ('error' in built) throw new Error(built.error);
  return built.invoice;
}

/** How a planned payout compares with net sales; and whether sales arrive somewhere other than the paying account. */
export function payoutPlan(o: { net: bigint; payouts: bigint; bills: bigint; company: Address; salesWallets: Address[] }) {
  const planned = o.payouts + o.bills;
  const elsewhere = o.salesWallets.filter((w) => !isAddressEqual(w, o.company));
  return { planned, left: o.net - planned, overSales: planned > o.net, topUpNeeded: elsewhere.length > 0, salesWallets: elsewhere };
}
