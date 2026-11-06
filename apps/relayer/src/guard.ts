import { formatEther, parseEther } from 'viem';

/** Too many requests from one IP or for one account: HTTP 429. */
export class Throttled extends Error {
  readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) { super(message); this.retryAfterSec = retryAfterSec; }
}
/** The relayer won't spend gas right now (low balance, or the daily budget is used): HTTP 503. */
export class Paused extends Error {}

export const PAUSED_HINT = 'anyone can still submit the same transaction themselves (Copy calldata), or through Ethereum';

/** Routes that make the relayer pay gas. */
export type GuardedRoute = '/approver' | '/pay' | '/payrun' | '/sync' | '/mandate' | '/pull' | '/revoke' | '/userop' | '/sandbox/admit'
  | '/checkout/pay' | '/checkout/refund' | '/checkout/subscribe' | '/checkout/cancel' | '/checkout/charge' | '/x402/settle' | '/webhooks/test' | 'cron'
  | '/checkout/deposit/settle' | '/checkout/deposit/refund';

export type GuardLimits = {
  /** Gas-spending requests per IP per hour, across all guarded routes. */
  perIpHour: number;
  /** Requests per account (or signer, mandate) per route per UTC day. */
  perAccountDay: number;
  /** New approver accounts per IP per UTC day (POST /approver deploys a contract). */
  approverPerIpDay: number;
  /** Stop sending below this balance (wei). */
  minBalance: bigint;
  /** At most this much gas spent per UTC day (wei), measured as the drop in the relayer's balance. */
  dailyBudget: bigint;
  /** Gas used by a typical payOne, for the runway estimate. */
  paymentGas: bigint;
};

export const DEFAULT_LIMITS: GuardLimits = {
  perIpHour: 30, perAccountDay: 60, approverPerIpDay: 5,
  minBalance: parseEther('0.05'), dailyBudget: parseEther('0.1'), paymentGas: 250_000n,
};

/** Limits from env: RELAYER_IP_PER_HOUR, RELAYER_ACCOUNT_PER_DAY, RELAYER_APPROVER_PER_IP_DAY, RELAYER_MIN_BALANCE_WBT, RELAYER_DAILY_BUDGET_WBT. */
export function limitsFromEnv(env: Record<string, string | undefined>): GuardLimits {
  const int = (k: string, d: number) => { const n = Number(env[k]); return Number.isInteger(n) && n > 0 ? n : d; };
  const wbt = (k: string, d: bigint) => { try { return env[k] ? parseEther(env[k]!.trim()) : d; } catch { return d; } };
  return {
    perIpHour: int('RELAYER_IP_PER_HOUR', DEFAULT_LIMITS.perIpHour),
    perAccountDay: int('RELAYER_ACCOUNT_PER_DAY', DEFAULT_LIMITS.perAccountDay),
    approverPerIpDay: int('RELAYER_APPROVER_PER_IP_DAY', DEFAULT_LIMITS.approverPerIpDay),
    minBalance: wbt('RELAYER_MIN_BALANCE_WBT', DEFAULT_LIMITS.minBalance),
    dailyBudget: wbt('RELAYER_DAILY_BUDGET_WBT', DEFAULT_LIMITS.dailyBudget),
    paymentGas: DEFAULT_LIMITS.paymentGas,
  };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Keeps the relayer's gas from being drained by curl loops. Rate limits are in memory, so on serverless hosts each
 * instance counts separately (a cold start resets them). The balance floor and the daily budget come from the chain
 * (the relayer's own balance), so they hold across instances.
 */
export function createGuard(o: {
  limits?: Partial<GuardLimits>;
  /** The relayer's current balance (wei); absent = no balance checks. */
  balance?: () => Promise<bigint>;
  gasPrice?: () => Promise<bigint>;
  now?: () => number;
  /** Balance reads are cached this long. */
  cacheMs?: number;
}) {
  const L: GuardLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const now = o.now ?? (() => Date.now());
  const cacheMs = o.cacheMs ?? 15_000;
  const hits = new Map<string, number[]>();
  let cached: { at: number; value: bigint } | null = null;
  let dayStart: { day: number; balance: bigint } | null = null;

  const take = (key: string, windowMs: number, max: number, what: string) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      throw new Throttled(`rate limited: at most ${max} ${what}`, Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)));
    }
    list.push(t);
    hits.set(key, list);
  };

  async function readBalance(): Promise<bigint | null> {
    if (!o.balance) return null;
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const value = await o.balance();
    cached = { at: now(), value };
    const day = Math.floor(now() / DAY);
    // the day's baseline: the first balance seen today, raised by any top-up
    if (!dayStart || dayStart.day !== day || value > dayStart.balance) dayStart = { day, balance: value };
    return value;
  }
  const spentToday = (balance: bigint) => (dayStart && dayStart.balance > balance ? dayStart.balance - balance : 0n);

  /** Throws Paused (503) or Throttled (429); otherwise records the request. */
  async function check(route: GuardedRoute, ip: string, account?: string | (string | undefined)[]) {
    const balance = await readBalance();
    if (balance !== null && balance < L.minBalance) {
      throw new Paused(`relayer paused: low balance (${formatEther(balance)} WBT, floor ${formatEther(L.minBalance)}); ${PAUSED_HINT}`);
    }
    if (balance !== null && spentToday(balance) >= L.dailyBudget) {
      throw new Paused(`relayer paused: today's gas budget (${formatEther(L.dailyBudget)} WBT) is used up; ${PAUSED_HINT}`);
    }
    if (route === '/approver') take(`approver:${ip}`, DAY, L.approverPerIpDay, 'new approver accounts per address per day');
    take(`ip:${ip}`, HOUR, L.perIpHour, 'relayed transactions per address per hour');
    // each key (payer, merchant, subscription…) has its own daily budget per route
    for (const k of (Array.isArray(account) ? account : [account])) if (k) take(`acct:${route}:${k.toLowerCase()}`, DAY, L.perAccountDay, `${route} requests per account per day`);
  }

  /** Only the balance floor and the daily budget (for the cron, which has no client IP). */
  async function checkBudget() {
    const balance = await readBalance();
    if (balance !== null && balance < L.minBalance) throw new Paused(`relayer paused: low balance (${formatEther(balance)} WBT, floor ${formatEther(L.minBalance)}); ${PAUSED_HINT}`);
    if (balance !== null && spentToday(balance) >= L.dailyBudget) throw new Paused(`relayer paused: today's gas budget (${formatEther(L.dailyBudget)} WBT) is used up; ${PAUSED_HINT}`);
  }

  /** For /health: balance, today's spend, runway and the limits in force. */
  async function health() {
    let balance: bigint | null = null;
    let gasPrice: bigint | null = null;
    try { balance = await readBalance(); } catch { /* RPC down */ }
    try { gasPrice = o.gasPrice ? await o.gasPrice() : null; } catch { /* RPC down */ }
    const usable = balance !== null && balance > L.minBalance ? balance - L.minBalance : 0n;
    const perPayment = gasPrice !== null ? gasPrice * L.paymentGas : null;
    const paused = balance !== null && (balance < L.minBalance || spentToday(balance) >= L.dailyBudget);
    return {
      balanceWBT: balance !== null ? formatEther(balance) : null,
      spentTodayWBT: balance !== null ? formatEther(spentToday(balance)) : null,
      runway: perPayment && perPayment > 0n ? { payments: Number(usable / perPayment), gasPerPayment: Number(L.paymentGas), gasPriceWei: gasPrice!.toString() } : null,
      paused,
      limits: {
        perIpHour: L.perIpHour, perAccountDay: L.perAccountDay, approverPerIpDay: L.approverPerIpDay,
        minBalanceWBT: formatEther(L.minBalance), dailyBudgetWBT: formatEther(L.dailyBudget),
        note: 'rate limits are per server instance (in memory); the balance floor and daily budget read the chain',
      },
    };
  }

  return { limits: L, check, checkBudget, health };
}

export type Guard = ReturnType<typeof createGuard>;
