// Writes the accountant's export for a merchant straight from Whitechain (no Tazor server): every checkout payment,
// refund, subscription charge and deposit payment, as CSV. Same code as the demo shop's "Accountant export" button.
//   MERCHANT=0x… node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/accountant-export.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { historyCsv, merchantHistory } from '../packages/pay/src/checkout.ts';

const merchant = (process.env.MERCHANT ?? '0x6B4E065d08D2cC7723635c6df0CC5268C706cD93') as `0x${string}`;
const rows = await merchantHistory(merchant);
const csv = historyCsv(rows);
mkdirSync('scripts/checkout-live', { recursive: true });
writeFileSync('scripts/checkout-live/accountant-export.csv', csv);
console.log(csv.split('\n').slice(0, 8).join('\n'));
console.log(`… ${rows.length} rows → scripts/checkout-live/accountant-export.csv`);
