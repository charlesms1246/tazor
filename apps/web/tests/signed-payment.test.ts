import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toEventSelector, toFunctionSelector, toHex, type Address, type Hex } from 'viem';
import { decodeSignedPayment, encodeSignedPayment, forwardCalldata, signedPaymentFrom, SIGNED_PAYMENT_PREFIX, type SignedPayment } from '../lib/signed-payment.ts';
import { encodeForward } from '../lib/ensgate.ts';

const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721' as Address;
const PAYEE = '0xc1dce946D192e344251972470237F1471C93876c' as Address;
const A1 = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as Address;
const A2 = '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967' as Address;
const auth = { invoiceHash: keccak256(toHex('INV-1')), account: ACME, payee: PAYEE, amount: 200_000n, expiry: 1_796_592_000n, nonce: 2n ** 255n + 7n };
const sigA = `0x${'ab'.repeat(65)}` as Hex;
const sigB = `0x${'cd'.repeat(260)}` as Hex;   // a long passkey (ERC-1271 / WebAuthn) signature
const base = { gate: '0xF7EB3B7E8295914eeaFc44aC26811DA03B41B656' as Address, paymentModule: '0x906620D82e2959351c81D731C67EA46DF71E36f3' as Address, whitechainChainId: 1874 };

/** The encoder block inside public/fallback.html, evaluated as plain JS. */
function htmlEncoder() {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'fallback.html'), 'utf8');
  const m = html.match(/\/\/ BEGIN ENCODER[^\n]*\n([\s\S]*?)\/\/ END ENCODER/);
  assert.ok(m, 'encoder block found');
  // eslint-disable-next-line no-new-func
  return new Function(`${m![1]}; return { encodeForward, decodeBlob, usdt, FORWARD_SELECTOR, INVOICE_PAID_TOPIC };`)() as {
    encodeForward(p: SignedPayment): string; decodeBlob(t: string): SignedPayment; usdt(b: string): string; FORWARD_SELECTOR: string; INVOICE_PAID_TOPIC: string;
  };
}

test('signed payment round-trips and encodes exactly what the Pay page sends to EnsGate', () => {
  for (const [label, approvals] of [['acme', [{ approver: A1, signature: sigA }]], ['sandbox-company-with-a-long-name', [{ approver: A1, signature: sigA }, { approver: A2, signature: sigB }]]] as const) {
    const blob = signedPaymentFrom({ ...base, label, auth, approvals: [...approvals], invoiceId: 'INV-1', supplier: 'Bluejay Logistics' });
    assert.ok(blob.startsWith(SIGNED_PAYMENT_PREFIX));
    const p = decodeSignedPayment(blob);
    assert.equal(p.auth.nonce, auth.nonce.toString());
    assert.equal(forwardCalldata(p), encodeForward(label, auth, [...approvals]));
  }
});

test('decodeSignedPayment refuses anything else with a plain sentence', () => {
  assert.throws(() => decodeSignedPayment('hello'), /not a Tazor signed payment/);
  assert.throws(() => decodeSignedPayment(`${SIGNED_PAYMENT_PREFIX}@@@`), /damaged/);
  const good = decodeSignedPayment(signedPaymentFrom({ ...base, label: 'acme', auth, approvals: [{ approver: A1, signature: sigA }] }));
  assert.throws(() => decodeSignedPayment(encodeSignedPayment({ ...good, approvers: [] })), /incomplete/);
  assert.throws(() => decodeSignedPayment(encodeSignedPayment({ ...good, label: 'Not A Label!' })), /incomplete/);
  assert.throws(() => decodeSignedPayment(encodeSignedPayment({ ...good, account: A2 })), /inconsistent/);
});

test('public/fallback.html: its vanilla encoder matches viem byte for byte, and its constants are right', () => {
  const h = htmlEncoder();
  assert.equal(`0x${h.FORWARD_SELECTOR}`, toFunctionSelector('forward(string,address,(bytes32,address,address,uint256,uint64,uint256),address[],bytes[])'));
  assert.equal(h.INVOICE_PAID_TOPIC, toEventSelector('InvoicePaid(address,uint256,address,uint256,bool)'));
  for (const [label, approvals] of [['a', [{ approver: A1, signature: sigA }]], ['acme', [{ approver: A1, signature: sigB }, { approver: A2, signature: sigA }]], ['x'.repeat(40), [{ approver: A2, signature: '0x' as Hex }]]] as const) {
    const blob = signedPaymentFrom({ ...base, label, auth, approvals: [...approvals] });
    const p = h.decodeBlob(blob);
    assert.equal(h.encodeForward(p), encodeForward(label, auth, [...approvals]), label);
  }
  assert.throws(() => h.decodeBlob('nope'), /not a Tazor signed payment/);
  assert.equal(h.usdt('200000'), '0.20 USDT');
  assert.equal(h.usdt('5'), '0.000005 USDT');
});

test('public/fallback.html: no external scripts, strict CSP, talks only to Whitechain', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'fallback.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.match(html, /connect-src https:\/\/rpc\.testnet\.whitechain\.io;/);
  assert.ok(!/taz0r|vercel\.app|relayer/i.test(html.replace(/taz0r\.eth \(/g, '').replace(/\$\{p\.label\}\.taz0r\.eth/g, '')), 'no Tazor servers');
});
