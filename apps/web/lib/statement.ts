import type { Address } from 'viem';
import type { Transfer } from './activity.ts';
import { csvField, usdt2dp } from './export.ts';

export const counterpartyOf = (t: Transfer): Address => (t.incoming ? t.from : t.to);
export const directionOf = (t: Transfer): 'Received' | 'Paid' => (t.incoming ? 'Received' : 'Paid');
export const signedAmount = (t: Transfer): bigint => (t.incoming ? t.amount : -t.amount);

/** On-chain USDT statement as CSV: Date (ISO), Counterparty, Direction, Amount (USDT, 2 dp, signed), Tx hash. */
export function toStatementCsv(transfers: Transfer[]): string {
  const rows = transfers.map((t) => [t.time, counterpartyOf(t), directionOf(t), usdt2dp(signedAmount(t)), t.txHash]);
  return [['Date', 'Counterparty', 'Direction', 'Amount (USDT)', 'Tx hash'], ...rows]
    .map((r) => r.map(csvField).join(','))
    .join('\r\n') + '\r\n';
}
