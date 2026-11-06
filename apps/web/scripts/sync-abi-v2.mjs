import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', '..', '..', 'contracts', 'out');
const NAMES = ['PaymentModuleV2', 'FinancingModule'];
const camel = (n) => n[0].toLowerCase() + n.slice(1);

for (const name of NAMES) {
  const { abi } = JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), 'utf8'));
  writeFileSync(
    join(import.meta.dirname, '..', 'lib', 'abi', `${name}.ts`),
    `export const ${camel(name)}Abi = ${JSON.stringify(abi, null, 2)} as const;\n`,
  );
  console.log(`${name}: ${abi.length} entries`);
}
