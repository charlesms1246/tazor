import { isAddressEqual, type Address } from 'viem';
import { BadRequest, addr } from './payment.ts';

export const REVOCATION_LIST_V2: Address = '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a';

/** Optional `list` in a /revoke body: must be one of the two known RevocationLists (default: v1). */
export function pickRevocationList(body: unknown, v1: Address | undefined, v2: Address): Address | undefined {
  const list = (body as { list?: unknown } | null)?.list;
  if (list === undefined || list === null) return v1;
  const a = addr(list, 'list');
  if ((v1 && isAddressEqual(a, v1)) || isAddressEqual(a, v2)) return a;
  throw new BadRequest('list must be the v1 or v2 RevocationList');
}
