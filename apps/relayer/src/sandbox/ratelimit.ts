/**
 * In-memory admission limits: at most `perDay` admissions in a rolling 24 h globally and `perIpHour` per IP per hour.
 * On serverless hosts each instance keeps its own counters, so the effective limit is per instance.
 */
export function createRateLimiter(opts: { perDay: number; perIpHour: number; now?: () => number }) {
  const now = opts.now ?? (() => Date.now());
  const global: number[] = [];
  const byIp = new Map<string, number[]>();
  const prune = (list: number[], windowMs: number) => { const t = now() - windowMs; while (list.length && list[0] <= t) list.shift(); };
  return {
    /** Records an admission if allowed; returns the reason and retry delay otherwise. */
    take(ip: string): { ok: true } | { ok: false; reason: string; retryAfterSec: number } {
      prune(global, 86_400_000);
      const mine = byIp.get(ip) ?? [];
      prune(mine, 3_600_000);
      if (global.length >= opts.perDay) return { ok: false, reason: `the sandbox admits at most ${opts.perDay} visitors a day`, retryAfterSec: Math.ceil((global[0] + 86_400_000 - now()) / 1000) };
      if (mine.length >= opts.perIpHour) return { ok: false, reason: `at most ${opts.perIpHour} admissions per hour from one address`, retryAfterSec: Math.ceil((mine[0] + 3_600_000 - now()) / 1000) };
      global.push(now()); mine.push(now()); byIp.set(ip, mine);
      return { ok: true };
    },
    /** Gives back an admission that was refused later (e.g. invalid account), so it doesn't count. */
    refund(ip: string) { global.pop(); byIp.get(ip)?.pop(); },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
