import type { Transfer } from './activity.ts';

export type DayFlow = { day: string; in: bigint; out: bigint };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Money in and out per UTC day for the last `days` days ending on `now`, oldest first. */
export function dailyFlows(transfers: Transfer[], days: number, now = new Date()): DayFlow[] {
  const out: DayFlow[] = [];
  const index = new Map<string, DayFlow>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const row = { day: isoDay(d), in: 0n, out: 0n };
    out.push(row);
    index.set(row.day, row);
  }
  for (const t of transfers) {
    const row = index.get(t.time.slice(0, 10));
    if (!row) continue;
    if (t.incoming) row.in += t.amount; else row.out += t.amount;
  }
  return out;
}

export const sumFlows = (rows: DayFlow[]) => rows.reduce((s, r) => ({ in: s.in + r.in, out: s.out + r.out }), { in: 0n, out: 0n });

/** A round axis maximum (1, 2 or 5 times a power of ten) at or above `max`, in whole USDT. */
export function niceMax(maxBase: bigint, decimals = 6): number {
  const v = Number(maxBase) / 10 ** decimals;
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
