import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { ensGateAbi } from '../lib/abi/EnsGate.ts';
import { encodeForward } from '../lib/ensgate.ts';
import { buildInvoiceAuth } from '../lib/invoice-auth.ts';
import { parseInvoice } from '../lib/invoice.ts';
import { defaultAuthParams } from '../lib/payment.ts';
import { blockscoutWriteUrl, forwardFields, forwardNote, parseForwardFields } from '../lib/blockscout-forward.ts';

const invoice = parseInvoice({
  id: 'INV-20261106-4F67', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
  token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', amount: '1180000', dueDate: 1798675200,
  lines: [{ description: 'Freight', quantity: '1', unitPrice: '1000000' }, { description: 'GST 18%', quantity: '1', unitPrice: '180000' }], memo: 'PO-2026-4471',
});
const { nonce, expiry } = defaultAuthParams(invoice);
const auth = buildInvoiceAuth(invoice, nonce, expiry);
const approvals = [
  { approver: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as const, signature: `0x${'ab'.repeat(65)}${'cd'.repeat(200)}` as `0x${string}` },
  { approver: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967' as const, signature: `0x${'11'.repeat(65)}` as `0x${string}` },
];

test('the five Blockscout values, parsed back, encode exactly the calldata the app would send', () => {
  const fields = forwardFields('acme', auth, approvals, invoice.id);
  assert.deepEqual(fields.map((f) => f.name), ['label', 'account', 'auth', 'approvers', 'signatures']);
  const values = Object.fromEntries(fields.map((f) => [f.name, f.value])) as Record<(typeof fields)[number]['name'], string>;
  const data = encodeFunctionData({ abi: ensGateAbi, functionName: 'forward', args: parseForwardFields(values) as never });
  assert.equal(data, encodeForward('acme', auth, approvals));

  // human-sized formats: plain label/address, JSON arrays (decimal integers, never base64 or scientific notation)
  assert.equal(values.label, 'acme');
  assert.equal(values.account, '0xb99A12652BEe98429ae31EA0529A0b63f1073721');
  const tuple = JSON.parse(values.auth);
  assert.deepEqual(tuple.slice(1, 4), ['0xb99A12652BEe98429ae31EA0529A0b63f1073721', '0xc1dce946D192e344251972470237F1471C93876c', '1180000']);
  assert.equal(tuple[5], nonce.toString());
  assert.match(tuple[5], /^\d+$/);
  assert.equal(values.approvers, '["0x00aBed5bDddf794c415eE746d3E4De5332cC5450","0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967"]');
  // one-by-one parts for UIs with a box per component/item
  assert.deepEqual(fields[2].parts!.map((p) => p.name), ['invoiceHash', 'account', 'payee', 'amount', 'expiry', 'nonce']);
  assert.deepEqual(fields[2].parts!.map((p) => p.label), ['Invoice reference', 'Buyer account', 'Payee', 'Amount in base units (6 decimals)', 'Expiry (unix time)', 'Nonce']);
  // Blockscout's form: one box per tuple component / list item; the parts, in order, are exactly the forward() arguments
  const fromParts = Object.fromEntries(fields.map((f) => [f.name, f.parts ? JSON.stringify(f.parts.map((p) => p.value)) : f.value])) as typeof values;
  assert.equal(encodeFunctionData({ abi: ensGateAbi, functionName: 'forward', args: parseForwardFields(fromParts) as never }), encodeForward('acme', auth, approvals));
  assert.deepEqual(fields[3].parts!.map((p) => [p.name, p.label]), [['approvers[0]', 'Approver 1'], ['approvers[1]', 'Approver 2']]);
  assert.match(fields[2].hint, /Click "auth \(tuple\)" to open it/);
  assert.match(fields[3].hint, /press \+ for the next/);
  assert.equal(fields[4].parts!.length, 2);
  assert.equal(fields[2].preview, 'INV-20261106-4F67 · 6 values');
});

test('the note and the Blockscout link', () => {
  const gate = '0xF7EB3B7E8295914eeaFc44aC26811DA03B41B656' as const;
  assert.equal(blockscoutWriteUrl(gate), 'https://eth-sepolia.blockscout.com/address/0xF7EB3B7E8295914eeaFc44aC26811DA03B41B656?tab=write_contract');
  const note = forwardNote(gate, forwardFields('acme', auth, approvals.slice(0, 1), invoice.id));
  assert.match(note, /^Tazor payment via Ethereum: EnsGate 0xF7EB/);
  assert.match(note, /\nlabel \(string\): acme\n/);
  assert.match(note, /\n  invoiceHash · Invoice reference: 0x[0-9a-f]{64}\n/);
  assert.match(note, /\n  signatures\[0\] · Approval 1: 0x/);
  assert.match(note, /Press Simulate first/);
  assert.throws(() => parseForwardFields({ label: 'acme', account: auth.account, auth: '["0x1"]', approvers: '[]', signatures: '[]' }), /6 values/);
});
