import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPayouts, payoutInvoice, payoutPlan } from '../lib/payouts.ts';

const CO = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const SUP = '0xbc9A2fc48F141162eafF4c0767DAc50362f96bc6';
const WALLET = '0x6B4E065d08D2cC7723635c6df0CC5268C706cD93';

test('supplier payouts: rows are checked; each becomes a normal invoice supplier → company, due today', () => {
  assert.deepEqual(checkPayouts([]), { ok: false, error: 'Add at least one supplier.', row: -1 });
  assert.match((checkPayouts([{ address: '0x12', name: 'A', amount: '1' }]) as { error: string }).error, /Supplier 1: enter their Whitechain address/);
  assert.match((checkPayouts([{ address: SUP, name: ' ', amount: '1' }]) as { error: string }).error, /enter a name/);
  assert.match((checkPayouts([{ address: SUP, name: 'Milk Co', amount: '0' }]) as { error: string }).error, /enter an amount/);
  assert.deepEqual(checkPayouts([{ address: SUP, name: 'Milk Co', amount: '1.25' }, { address: SUP, name: 'Tea Co', amount: '0.75' }]), { ok: true, total: 2_000_000n });

  const inv = payoutInvoice(CO as never, { address: SUP, name: 'Milk Co', amount: '1.25' }, 1, Date.parse('2026-11-07T10:00:00Z'));
  assert.deepEqual([inv.id, inv.buyerAccount, inv.payee, inv.supplierName, inv.amount, inv.dueDate, inv.memo], ['PAYOUT-20261107-1', CO, SUP, 'Milk Co', 1_250_000n, Date.parse('2026-11-07T00:00:00Z') / 1000, 'Paid from checkout sales']);
});

test('payout plan: compares with net sales and flags a sales wallet that is not the paying company account', () => {
  const p = payoutPlan({ net: 3_000_000n, payouts: 2_000_000n, bills: 500_000n, company: CO as never, salesWallets: [WALLET as never, CO as never] });
  assert.deepEqual(p, { planned: 2_500_000n, left: 500_000n, overSales: false, topUpNeeded: true, salesWallets: [WALLET] });
  const same = payoutPlan({ net: 1_000_000n, payouts: 2_000_000n, bills: 0n, company: CO as never, salesWallets: [CO as never] });
  assert.deepEqual([same.overSales, same.topUpNeeded, same.left], [true, false, -1_000_000n]);
});
