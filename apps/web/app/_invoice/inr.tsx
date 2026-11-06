import { INR_RATE_NOTE, inrText } from '@/lib/money.ts';

/** "≈ ₹10,384.00" next to a USDT amount, with the reference-rate note on hover; never part of the amount's own text. */
export function Inr({ v, testId }: { v: bigint; testId?: string }) {
  return <span className="inr" title={INR_RATE_NOTE} data-testid={testId}>{inrText(v)}</span>;
}
