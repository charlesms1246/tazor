/** "Request a refund" from a receipt: a message for the business with a one-click link to refund this order. */
import { getAddress } from 'viem';

const AMOUNT = /^\d+(\.\d{1,6})?$/;
/** null when fine; otherwise a plain-English problem. An empty amount means "the full amount". */
export function refundAmountError(amount: string, maxUsdt: number): string | null {
  const a = amount.trim();
  if (!a) return null;
  if (!AMOUNT.test(a) || Number(a) <= 0) return 'Enter an amount like 2 or 1.50, or leave it empty for the full amount';
  if (Number(a) > maxUsdt + 1e-9) return `At most ${maxUsdt.toFixed(2)} USDT can still be refunded`;
  return null;
}

/** The business's Checkout page, opened on this order with the refund amount filled in. */
export const refundDeepLink = (origin: string, merchant: string, orderId: string, amount?: string) =>
  `${origin}/checkout/?merchant=${getAddress(merchant)}&tab=orders&order=${orderId.toLowerCase()}${amount?.trim() ? `&refund=${encodeURIComponent(amount.trim())}` : ''}`;

export function refundRequestMessage(o: {
  business: string | null; order: string; paid: string; paidOn: string | null; amount: string; reason: string; deepLink: string; receipt: string;
}): { subject: string; body: string } {
  const what = o.amount.trim() ? `${o.amount.trim()} USDT` : `the full amount (${o.paid} USDT)`;
  const body = [
    `Hello${o.business ? ` ${o.business}` : ''},`,
    '',
    `I would like a refund for order ${o.order}, paid ${o.paid} USDT${o.paidOn ? ` on ${o.paidOn}` : ''}.`,
    `Amount: ${what}`,
    `Reason: ${o.reason.trim() || 'not given'}`,
    '',
    `You can refund it in one click here (it can only go back to me): ${o.deepLink}`,
    `My receipt: ${o.receipt}`,
    '',
    'Thank you.',
  ].join('\n');
  return { subject: `Refund request: order ${o.order}`, body };
}

const KEY = 'tazor.refund-requests.v1';
const read = (): Record<string, number> => { try { const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
export const refundRequestedAt = (orderId: string): number | null => read()[orderId.toLowerCase()] ?? null;
export function recordRefundRequest(orderId: string, at = Date.now()) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...read(), [orderId.toLowerCase()]: at })); } catch { /* storage full */ }
}
