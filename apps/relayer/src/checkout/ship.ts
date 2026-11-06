import type { Hex } from 'viem';
import { readyToShip, type ShipPolicy, type Stage } from '../../../../packages/pay/src/checkout.ts';
import type { Webhooks } from '../webhooks.ts';

export { readyToShip };

/** The merchant's rule and today's decision for one payment, as the relayer reports it. */
export function shipView(webhooks: Webhooks | undefined, merchant: string, amount: bigint, stage: Stage | null) {
  const policy: ShipPolicy = webhooks?.shipPolicyFor(merchant) ?? { waitForEthereumAbove: '100' };
  const d = readyToShip(amount, stage, policy);
  return { ...d, shipAbove: policy.waitForEthereumAbove };
}

/** Sends order.ready once (idempotency id `${orderId}:ready`) when the payment may ship. */
export async function emitReady(webhooks: Webhooks | undefined, e: { orderId: Hex; merchant: string; amount: bigint; stage: Stage | null; txHash: Hex | null; source?: 'deposit' }) {
  const ship = shipView(webhooks, e.merchant, e.amount, e.stage);
  if (!ship.ready || !webhooks) return ship;
  await webhooks.emit({
    id: `${e.orderId}:ready`, type: 'order.ready', merchant: e.merchant, txHash: e.txHash,
    data: { orderId: e.orderId, merchant: e.merchant, amount: e.amount.toString(), stage: e.stage, waitFor: ship.waitFor, shipAbove: ship.shipAbove, reason: ship.reason, ...(e.source ? { source: e.source } : {}) },
  }).catch(() => null);
  return ship;
}
