import { getAddress, type Address } from 'viem';

export type Transfer = { id: string; time: string; from: Address; to: Address; amount: bigint; txHash: string; incoming: boolean };

type Item = {
  timestamp: string; log_index: number; transaction_hash: string;
  from: { hash: string }; to: { hash: string }; total: { value: string };
  token: { address_hash?: string; address?: string };
};

/** Parses a Blockscout v2 token-transfers response into transfers of one token for one account. */
export function parseTransfers(body: unknown, account: Address, token: Address): Transfer[] {
  const items = (body as { items?: Item[] })?.items;
  if (!Array.isArray(items)) throw new Error('unexpected explorer response');
  const me = account.toLowerCase();
  const tok = token.toLowerCase();
  const seen = new Set<string>();
  const out: Transfer[] = [];
  for (const i of items) {
    const t = (i.token?.address_hash ?? i.token?.address ?? '').toLowerCase();
    if (t && t !== tok) continue;
    const id = `${i.transaction_hash}:${i.log_index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const from = getAddress(i.from.hash);
    const to = getAddress(i.to.hash);
    out.push({ id, time: i.timestamp, from, to, amount: BigInt(i.total.value), txHash: i.transaction_hash, incoming: to.toLowerCase() === me });
  }
  return out;
}

export async function fetchTransfers(explorer: string, account: Address, token: Address, f: typeof fetch = fetch): Promise<Transfer[]> {
  const res = await f(`${explorer}/api/v2/addresses/${account}/token-transfers?type=ERC-20&token=${token}`);
  if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
  return parseTransfers(await res.json(), account, token);
}

/** Names for the demo's known accounts on Whitechain Sepolia. */
export const KNOWN: Record<string, string> = {
  '0xc1dce946': 'bluejay.taz0r.eth',
  '0xea5a4be3': 'acme.taz0r.eth (v1)',
  '0x18d1': 'acme-v2.taz0r.eth',
  '0xb99a1265': 'acme.taz0r.eth',
  '0xce4389ac': 'Tazor test treasury',
};
export const nameOf = (a: Address): string | null => {
  const l = a.toLowerCase();
  for (const [k, v] of Object.entries(KNOWN)) if (l.startsWith(k)) return v;
  return null;
};
