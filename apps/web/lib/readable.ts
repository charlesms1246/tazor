/** A short, human reference for a long id (hash, digest, mandate id, claim id): "#a1b2c3". */
export function shortRef(id: string | bigint): string {
  const hex = typeof id === 'bigint' ? id.toString(16).padStart(64, '0') : /^\d+$/.test(id) ? BigInt(id).toString(16).padStart(64, '0') : id.replace(/^0x/, '');
  return `#${hex.slice(0, 6).toLowerCase()}`;
}

/** "30 days", "7 days", "1 day" from seconds. */
export function periodText(seconds: bigint | number): string {
  const d = Number(seconds) / 86400;
  return d === 1 ? '1 day' : Number.isInteger(d) ? `${d} days` : `${(Number(seconds) / 3600).toFixed(0)} hours`;
}

/** "13 Nov" (adds the year when it isn't this year) from unix seconds. */
export function dayText(unixSeconds: bigint | number, now = Date.now()): string {
  const d = new Date(Number(unixSeconds) * 1000);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

// One source for addresses and amounts across the app (shared with the other pages).
export { shortAddress, usdtText } from './human.ts';
