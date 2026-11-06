import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { WHITECHAIN_SEPOLIA_USDT, buildInvoiceAuth } from '../lib/invoice-auth.ts';
import { invoiceHash, type Invoice } from '../lib/invoice.ts';
import {
  AUTH_VALIDITY_AFTER_DUE, decodeInvoiceDigest, defaultAuthParams, encodeInvoiceDigestCall, encodePayOne,
  mergeApprovals, parseApprovals, relayerBody, serializeApproval,
} from '../lib/payment.ts';
import { backupSigner } from '../lib/approver-signature.ts';
import { encodePayOne as relayerEncodePayOne, parsePayRequest } from '../../relayer/src/payment.ts';

const invoice: Invoice = {
  id: 'INV-2026-0001', supplierName: 'Acme Steel Pvt Ltd',
  supplierAccount: '0x0000000000000000000000000000000000000002', payee: '0x0000000000000000000000000000000000000003',
  buyerAccount: '0x0000000000000000000000000000000000000001', token: WHITECHAIN_SEPOLIA_USDT, amount: 1_250_500000n,
  dueDate: 1798761600, lines: [{ description: 'Steel rods 12mm', quantity: 100n, unitPrice: 12_000000n }, { description: 'Delivery', quantity: 1n, unitPrice: 50_500000n }],
  memo: 'PO 4471',
};
const A1: Address = '0x00000000000000000000000000000000000A11cE';
const A2: Address = '0x0000000000000000000000000000000000000b0b';
const approvals = [{ approver: A1, signature: '0xaa01' as Hex }, { approver: A2, signature: '0xbb02bb02' as Hex }];

test('defaultAuthParams is deterministic from the invoice', () => {
  const p = defaultAuthParams(invoice);
  assert.equal(p.nonce, BigInt(invoiceHash(invoice)));
  assert.equal(p.expiry, BigInt(invoice.dueDate) + AUTH_VALIDITY_AFTER_DUE);
  assert.deepEqual(defaultAuthParams({ ...invoice }), p);
});

test('invoiceDigest call encodes the selector and decodes a bytes32', () => {
  const { nonce, expiry } = defaultAuthParams(invoice);
  const data = encodeInvoiceDigestCall(buildInvoiceAuth(invoice, nonce, expiry));
  assert.equal(data.length, 2 + 8 + 6 * 64);
  const d = '0xb7399b5d83c93cf90a0e136bc1f0b4817ff78004f1bcba9ea9c07f645e7b707b';
  assert.equal(decodeInvoiceDigest(encodeAbiParameters([{ type: 'bytes32' }], [d])), d);
});

test('approval JSON round trip, array or single, dedupe by approver', () => {
  const one = parseApprovals(serializeApproval(approvals[0]));
  assert.deepEqual(one, [approvals[0]]);
  const many = parseApprovals(JSON.stringify(approvals));
  assert.equal(many.length, 2);
  assert.equal(mergeApprovals(one, many).length, 2);
  assert.throws(() => parseApprovals('{"approver":"0x1"}'));
  assert.throws(() => parseApprovals('{"approver":"0x1234","signature":"0x00"}'));
});

test('payOne calldata equals the relayer encoding, and the relayer accepts relayerBody', () => {
  const { nonce, expiry } = defaultAuthParams(invoice);
  const auth = buildInvoiceAuth(invoice, nonce, expiry);
  const body = JSON.parse(JSON.stringify(relayerBody(auth, approvals)));
  const parsed = parsePayRequest(body);
  assert.equal(relayerEncodePayOne(parsed), encodePayOne(auth, approvals));
  assert.ok(encodePayOne(auth, approvals).startsWith('0xcc807045'));
});

test('backup signer id is the 20-byte address', () => {
  assert.equal(backupSigner(A1).toLowerCase(), A1.toLowerCase());
});
