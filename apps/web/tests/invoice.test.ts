import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeAbiParameters, keccak256, stringToHex, type Address } from 'viem';
import { canonicalInvoiceJson, invoiceHash, parseInvoice, type Invoice } from '../lib/invoice.ts';
import { decodeInvoiceLink, encodeInvoiceLink } from '../lib/invoice-link.ts';
import {
  buildInvoiceAuth, checkServerValue, invoiceAuthDigest, invoiceAuthStructHash, WHITECHAIN_SEPOLIA_USDT,
} from '../lib/invoice-auth.ts';

const ORIGIN = 'https://taz0r.eth.limo';
const NONCE = 7n;
const EXPIRY = 2000000000n;
const DOMAIN = { chainId: 1874, verifyingContract: '0x000000000000000000000000000000000000dEaD' as Address };

const fixture = (): Invoice => ({
  id: 'INV-2026-0001',
  supplierName: 'Acme Steel Pvt Ltd',
  supplierAccount: '0x0000000000000000000000000000000000000002',
  payee: '0x0000000000000000000000000000000000000003',
  buyerAccount: '0x0000000000000000000000000000000000000001',
  token: WHITECHAIN_SEPOLIA_USDT,
  amount: 1_250_500000n,
  dueDate: 1798761600,
  lines: [
    { description: 'Steel rods 12mm', quantity: 100n, unitPrice: 12_000000n },
    { description: 'Delivery', quantity: 1n, unitPrice: 50_500000n },
  ],
  memo: 'PO 4471',
});

const flipChar = (s: string, at: number) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);

test('link round trip', async () => {
  const link = await encodeInvoiceLink(fixture(), ORIGIN);
  assert.match(link, /^https:\/\/taz0r\.eth\.limo\/pay\/#v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await decodeInvoiceLink(link), parseInvoice(fixture()));
});

test('tampered ciphertext throws', async () => {
  const link = await encodeInvoiceLink(fixture(), ORIGIN);
  const [base, frag] = link.split('#');
  const [v, data, key] = frag.split('.');
  const tampered = `${base}#${v}.${flipChar(data, 30)}.${key}`;
  await assert.rejects(decodeInvoiceLink(tampered));
});

test('wrong key throws', async () => {
  const a = await encodeInvoiceLink(fixture(), ORIGIN);
  const b = await encodeInvoiceLink(fixture(), ORIGIN);
  const otherKey = b.split('.').at(-1);
  await assert.rejects(decodeInvoiceLink(a.replace(/[^.]+$/, otherKey!)));
});

test('invoiceHash is stable across key-order shuffles', () => {
  const f = fixture();
  const shuffled = Object.fromEntries(Object.entries(f).reverse()) as Invoice;
  shuffled.lines = f.lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity, description: l.description }));
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(f));
  assert.notDeepEqual(Object.keys(shuffled.lines[0]), Object.keys(f.lines[0]));
  assert.equal(invoiceHash(shuffled), invoiceHash(f));
  assert.equal(canonicalInvoiceJson(shuffled), canonicalInvoiceJson(f));
});

test('lines that do not sum to amount are rejected', () => {
  assert.throws(() => parseInvoice({ ...fixture(), amount: 1_250_500001n }), /lines sum/);
  assert.throws(() => invoiceHash({ ...fixture(), amount: 1n }), /lines sum/);
});

test('digest changes with amount, payee, chainId', () => {
  const base = buildInvoiceAuth(fixture(), NONCE, EXPIRY);
  const d = invoiceAuthDigest(base, DOMAIN);
  assert.notEqual(invoiceAuthDigest({ ...base, amount: base.amount + 1n }, DOMAIN), d);
  assert.notEqual(invoiceAuthDigest({ ...base, payee: '0x0000000000000000000000000000000000000004' }, DOMAIN), d);
  assert.notEqual(invoiceAuthDigest(base, { ...DOMAIN, chainId: 1875 }), d);
});

test('checkServerValue flags server-tampered amount and payee', () => {
  const good = buildInvoiceAuth(fixture(), NONCE, EXPIRY);
  assert.deepEqual(checkServerValue(good, fixture(), NONCE, EXPIRY), []);
  const bad = { ...good, amount: good.amount * 10n, payee: '0x000000000000000000000000000000000000bEEF' as Address };
  const m = checkServerValue(bad, fixture(), NONCE, EXPIRY);
  assert.equal(m.length, 2);
  assert.ok(m.some((x) => x.startsWith('amount:')));
  assert.ok(m.some((x) => x.startsWith('payee:')));
});

test('test vector', () => {
  const auth = buildInvoiceAuth(fixture(), NONCE, EXPIRY);
  console.log('canonical    ', canonicalInvoiceJson(fixture()));
  console.log('invoiceHash  ', auth.invoiceHash);
  console.log('auth         ', JSON.stringify(auth, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  console.log('domain       ', JSON.stringify({ name: 'Tazor', version: '1', ...DOMAIN }));
  const typeHash = keccak256(stringToHex(
    'InvoiceAuth(bytes32 invoiceHash,address account,address payee,uint256 amount,uint64 expiry,uint256 nonce)',
  ));
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [
      keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
      keccak256(stringToHex('Tazor')), keccak256(stringToHex('1')), BigInt(DOMAIN.chainId), DOMAIN.verifyingContract,
    ],
  ));
  const manualStruct = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint256' }],
    [typeHash, auth.invoiceHash, auth.account, auth.payee, auth.amount, auth.expiry, auth.nonce],
  ));
  const manualDigest = keccak256(concat(['0x1901', domainSeparator, manualStruct]));
  assert.equal(invoiceAuthStructHash(auth), manualStruct);
  assert.equal(invoiceAuthDigest(auth, DOMAIN), manualDigest);
  console.log('typeHash     ', typeHash);
  console.log('domainSep    ', domainSeparator);
  console.log('structHash   ', invoiceAuthStructHash(auth));
  console.log('digest       ', invoiceAuthDigest(auth, DOMAIN));
});
