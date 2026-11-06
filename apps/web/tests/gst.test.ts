import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGst, gstProblem, gstSplit, isGstin, readGst, stateName, stateOfGstin } from '../lib/gst.ts';
import { decodeInvoiceLink, decodeInvoiceLinkMeta, encodeInvoiceLink } from '../lib/invoice-link.ts';
import { canonicalInvoiceJson, invoiceHash, parseInvoice } from '../lib/invoice.ts';

const BLUEJAY_GSTIN = '27AABCB1234C1Z5';
const ACME_MH = '27AACCA5678D1Z2';
const ACME_KA = '29AACCA5678D1Z0';

test('GSTIN, states, HSN/SAC validation', () => {
  assert.equal(isGstin(BLUEJAY_GSTIN), true);
  assert.equal(isGstin(' 27aabcb1234c1z5 '), true);
  assert.equal(isGstin('99AABCB1234C1Z5'), false, 'unknown state');
  assert.equal(isGstin('27AABCB1234C1X5'), false);
  assert.equal(stateOfGstin(ACME_KA), '29');
  assert.equal(stateName('27'), 'Maharashtra');
  assert.equal(gstProblem({ supplierGstin: 'GSTIN?' }), 'Supplier GSTIN must be 15 characters like 27AABCB1234C1Z5.');
  assert.equal(gstProblem({ hsn: ['996511', '12'] }), 'Line 2: HSN/SAC must be 4 to 8 digits.');
  assert.equal(gstProblem({ supplierGstin: BLUEJAY_GSTIN, buyerGstin: ACME_MH, placeOfSupply: '27', hsn: ['996511', ''] }), null);
  assert.equal(cleanGst({ supplierGstin: ' ', hsn: ['', ' '] }), null);
  assert.deepEqual(cleanGst({ supplierGstin: '27aabcb1234c1z5', hsn: ['996511', ''] }), { supplierGstin: BLUEJAY_GSTIN, hsn: ['996511', ''] });
});

test('tax split: same state → CGST + SGST (exact halves), other state → IGST, unknown → none', () => {
  const tax = { rate: '18', amount: 180_001n };
  const same = gstSplit(tax, { supplierGstin: BLUEJAY_GSTIN, placeOfSupply: '27' });
  assert.equal(same.kind, 'cgst-sgst');
  assert.deepEqual(same.parts.map((p) => [p.label, p.rate, p.amount]), [['CGST', '9', 90_000n], ['SGST', '9', 90_001n]]);
  assert.equal(same.parts[0].amount + same.parts[1].amount, tax.amount);
  const inter = gstSplit(tax, { supplierGstin: BLUEJAY_GSTIN, buyerGstin: ACME_KA });
  assert.deepEqual(inter.parts.map((p) => [p.label, p.rate, p.amount]), [['IGST', '18', 180_001n]]);
  assert.equal(gstSplit(tax, { buyerGstin: ACME_KA }).kind, 'none');
  assert.equal(gstSplit({ rate: '12.5', amount: 10n }, { supplierGstin: BLUEJAY_GSTIN, placeOfSupply: '27' }).parts[0].rate, '6.25');
});

test('GST travels in the encrypted link but outside the signed invoice: same invoice, same hash, old decoders unaffected', async () => {
  const invoice = parseInvoice({
    id: 'INV-GST-1', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
    payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
    token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', amount: '1180000', dueDate: 1798675200,
    lines: [{ description: 'Freight', quantity: '1', unitPrice: '1000000' }, { description: 'GST 18%', quantity: '1', unitPrice: '180000' }], memo: '',
  });
  const gst = { supplierGstin: BLUEJAY_GSTIN, buyerGstin: ACME_MH, placeOfSupply: '27', hsn: ['996511'] };
  const withGst = await encodeInvoiceLink(invoice, 'http://x', gst);
  const plain = await encodeInvoiceLink(invoice, 'http://x');
  const a = await decodeInvoiceLink(withGst);
  assert.equal(canonicalInvoiceJson(a), canonicalInvoiceJson(invoice));
  assert.equal(invoiceHash(a), invoiceHash(invoice));
  const m = await decodeInvoiceLinkMeta(withGst);
  assert.deepEqual(m.gst, gst);
  assert.equal(invoiceHash(m.invoice), invoiceHash(invoice));
  assert.equal((await decodeInvoiceLinkMeta(plain)).gst, null);
  // malformed GST in a link is dropped, never shown
  assert.equal(readGst({ supplierGstin: 'nope' }), null);
});
