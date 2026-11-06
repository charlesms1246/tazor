/**
 * Is the business behind a payment verified? Its own address on the WB Soul mirror, or (for a Tazor company account)
 * one of the company's admins. On the test network the WB Soul registry is a simulated mirror, and the UI says so.
 */
import type { Address, Hex } from 'viem';
import { config } from './config.ts';
import { verifiedSoulOf, verifyCompany } from './soul.ts';

export type Trust = { verified: true; via: 'business' | 'company-admin' } | { verified: false } | { verified: null };
type Call = (to: Address, data: Hex) => Promise<Hex>;

export async function merchantTrust(merchant: Address, o: { mirror?: Address | null; paymentModule?: Address | null; call?: Call } = {}): Promise<Trust> {
  const mirror = o.mirror === undefined ? config.wbSoulMirror : o.mirror;
  const paymentModule = o.paymentModule === undefined ? config.paymentModule : o.paymentModule;
  if (!mirror) return { verified: null };
  try {
    if ((await verifiedSoulOf(mirror, merchant, o.call)) !== null) return { verified: true, via: 'business' };
  } catch { return { verified: null }; }
  if (!paymentModule) return { verified: false };
  try {
    const c = await verifyCompany(merchant, { paymentModule, mirror, call: o.call });
    return c.verified ? { verified: true, via: 'company-admin' } : { verified: false };
  } catch {
    // not a contract account (or a read failed): judged on its own address only
    return { verified: false };
  }
}

const cache = new Map<string, Promise<Trust>>();
/** One read per business per page load. */
export const merchantTrustCached = (merchant: Address) => {
  const k = merchant.toLowerCase();
  if (!cache.has(k)) cache.set(k, merchantTrust(merchant));
  return cache.get(k)!;
};

export const TRUST_TOOLTIP =
  'A real person behind this business passed WhiteBIT identity checks (WB Soul). On this test network the WB Soul registry is a simulated mirror, so treat it as a demo of the check.';
