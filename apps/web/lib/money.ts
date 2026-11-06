import { formatUnits } from 'viem';

/** USDT base units as a person reads them: "1.20", "118.00", "0.000005" (2 decimals, more only when non-zero). */
export function usdtNumber(v: bigint): string {
  const [w, f = ''] = formatUnits(v, 6).split('.');
  return `${w}.${f.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** "1.20 USDT" */
export const usdtText = (v: bigint): string => `${usdtNumber(v)} USDT`;

/**
 * Indicative rupee equivalents for Indian finance teams. A STATIC reference rate (not a live quote), shown as "≈ ₹…"
 * and labelled indicative wherever it appears. Nothing is converted or settled in rupees.
 */
export const INR_PER_USDT = 88;
export const INR_RATE_NOTE = `Indicative: 1 USDT ≈ ₹${INR_PER_USDT.toFixed(2)} (static reference rate, not a live quote)`;

/** Base units of USDT → paise at the reference rate (exact integer arithmetic, rounded half-up to the paisa). */
export const inrPaise = (v: bigint): bigint => (v * BigInt(INR_PER_USDT * 100) * 2n + 1_000_000n) / 2_000_000n;

/** "≈ ₹10,384.00": Indian digit grouping (lakh/crore), two decimals. */
export function inrText(v: bigint): string {
  const paise = inrPaise(v < 0n ? -v : v);
  const rupees = (paise / 100n).toString();
  const head = rupees.length > 3 ? rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + rupees.slice(-3) : rupees;
  return `≈ ${v < 0n ? '−' : ''}₹${head}.${(paise % 100n).toString().padStart(2, '0')}`;
}
