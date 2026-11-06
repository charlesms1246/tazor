#!/usr/bin/env node
// Test double for the role prover: prints a fixed proof, or fails while FAKE_PROVER_FAIL names an existing file.
import { existsSync, appendFileSync } from 'node:fs';
const [registry, account] = process.argv.slice(2);
if (process.env.FAKE_PROVER_LOG) appendFileSync(process.env.FAKE_PROVER_LOG, `${registry} ${account}\n`);
if (process.env.FAKE_PROVER_FAIL && existsSync(process.env.FAKE_PROVER_FAIL)) {
  console.error('prover boom');
  process.exit(1);
}
console.log('building proof...');
console.log('0xdeadbeefcafe');
