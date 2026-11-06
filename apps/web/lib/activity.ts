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

/** Names for the demo's known accounts on Whitechain Sepolia, matched on the full address only. */
export const KNOWN: Record<string, string> = {
  '0xc1dce946d192e344251972470237f1471c93876c': 'bluejay.taz0r.eth',
  '0xea5a4be313e05eb254900b6adbb7d655c55242f6': 'acme.taz0r.eth (v1)',
  '0x18d15b034c645dbbfcb9c68238a14d059f632513': 'acme-v2.taz0r.eth',
  '0xb99a12652bee98429ae31ea0529a0b63f1073721': 'acme.taz0r.eth',
  '0xce4389acb79463062c362facb8cb04513fa3d8d8': 'Tazor test treasury',
};
export const nameOf = (a: string): string | null => KNOWN[a.toLowerCase()] ?? null;
