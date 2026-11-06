import { formatUnits } from 'viem';

/** USDT base units as a person reads them: "1.20", "118.00", "0.000005" (2 decimals, more only when non-zero). */
export function usdtNumber(v: bigint): string {
  const [w, f = ''] = formatUnits(v, 6).split('.');
  return `${w}.${f.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** "1.20 USDT" */
export const usdtText = (v: bigint): string => `${usdtNumber(v)} USDT`;
