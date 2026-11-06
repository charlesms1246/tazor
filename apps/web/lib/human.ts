/**
 * Turns machine strings into text a person can read: no hashes, no 42-character addresses, no huge integers.
 * Shared by every page (with app/_human/chip.tsx for addresses shown as chips).
 */
import { parseUnits } from 'viem';
import { usdtNumber } from './money.ts';

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const HASH = /0x[0-9a-fA-F]{64}\b/g;
const LONG_HEX = /0x[0-9a-fA-F]{41,}\b/g;
const ADDRESS = /0x[0-9a-fA-F]{40}\b/g;
const BIG_INT = /\b\d{13,}\b/g;

/**
 * Plain text for a log line or an error: transaction hashes and digests are dropped (the UI links them instead),
 * other long hex (calldata, signatures) becomes "(data)", addresses become 0x1234…abcd (or a known name), and
 * integers of 13+ digits become "a reference number".
 */
export function plain(text: string, names: Record<string, string> = {}): string {
  return text
    .replace(HASH, '')
    .replace(LONG_HEX, '(data)')
    .replace(ADDRESS, (a) => names[a.toLowerCase()] ?? shortAddress(a))
    .replace(BIG_INT, 'a reference number')
    .replace(/\(\s*\)/g, '')
    .replace(/:\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

/**
 * "0.20 USDT" from base units (bigint, 6 decimals) or a decimal USDT string/number. Exact (bigint), 2 decimals,
 * more only when non-zero ("0.000005 USDT"); the one formatter is usdtNumber in lib/money.ts.
 */
export function usdtText(v: bigint | string | number): string {
  let base: bigint;
  try {
    base = typeof v === 'bigint' ? v : parseUnits(String(v).trim(), 6);
  } catch {
    base = 0n;
  }
  return `${usdtNumber(base)} USDT`;
}
