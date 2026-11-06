import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import { WHITECHAIN_SEPOLIA_USDT, buildInvoiceAuth } from '../lib/invoice-auth.ts';
import type { Invoice } from '../lib/invoice.ts';
import { defaultAuthParams, encodePayOne } from '../lib/payment.ts';
import { encodeForward, invoicePaidTopics } from '../lib/ensgate.ts';
import { PERIODS, encodeCreateMandate, encodePull, mandateDigest, mandateRelayerBody, type Mandate } from '../lib/mandate.ts';
import { TIMINGS } from '../lib/timings.ts';

const invoice: Invoice = {
  id: 'INV-7', supplierName: 'Bluejay Logistics', supplierAccount: '0xc1dce946D192e344251972470237F1471C93876c',
  payee: '0xc1dce946D192e344251972470237F1471C93876c', buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  token: WHITECHAIN_SEPOLIA_USDT, amount: 1_200_000n, dueDate: 1798761600,
  lines: [{ description: 'Freight', quantity: 1n, unitPrice: 1_200_000n }], memo: 'PO 12',
};
const { nonce, expiry } = defaultAuthParams(invoice);
const auth = buildInvoiceAuth(invoice, nonce, expiry);
const approvals = [
  { approver: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450' as Address, signature: '0xaa01' as Hex },
  { approver: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967' as Address, signature: '0xbb02bb02' as Hex },
];
const tuple = '(bytes32 invoiceHash,address account,address payee,uint256 amount,uint64 expiry,uint256 nonce)';

test('EnsGate.forward calldata equals an independent viem encoding', () => {
  const abi = parseAbi([`function forward(string label, address account, ${tuple} auth, address[] approvers, bytes[] signatures)`]);
  const expected = encodeFunctionData({
    abi, functionName: 'forward',
    args: ['acme', auth.account, auth, approvals.map((a) => a.approver), approvals.map((a) => a.signature)],
  });
  assert.equal(encodeForward('acme', auth, approvals), expected);
});

test('forward carries exactly the same auth and approvals as payOne', () => {
  const fwdAbi = parseAbi([`function forward(string, address, ${tuple}, address[], bytes[])`]);
  const payAbi = parseAbi([`function payOne(address, ${tuple}, address[], bytes[])`]);
  const f = decodeFunctionData({ abi: fwdAbi, data: encodeForward('acme', auth, approvals) }).args;
  const p = decodeFunctionData({ abi: payAbi, data: encodePayOne(auth, approvals) }).args;
  assert.equal(f[0], 'acme');
  assert.deepEqual(f.slice(1), p);
});

test('InvoicePaid topics filter by account and nonce', () => {
  const t = invoicePaidTopics(auth.account, auth.nonce);
  assert.equal(t[0], keccak256(stringToHex('InvoicePaid(address,uint256,address,uint256,bool)')));
  assert.equal(BigInt(t[1] as Hex), BigInt(auth.account));
  assert.equal(BigInt(t[2] as Hex), auth.nonce);
});

const MM: Address = '0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32';
const live: Mandate = {
  account: '0x18d15B034C645dbbFCb9c68238A14D059f632513', payee: '0xc1dce946D192e344251972470237F1471C93876c',
  capPerPeriod: 2_000_000n, period: PERIODS.monthly, expiry: 1_801_719_053n, nonce: 1n,
};

test('mandate digest reproduces the live mandate id', () => {
  assert.equal(mandateDigest(live, MM, 1874), '0x08d47f1cfdc3adfe04d41ce6135822149f4440ebf88fdc6b34612c9049c2e574');
  const k = (s: string) => keccak256(stringToHex(s));
  const domainSep = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), k('Tazor'), k('1'), 1874n, MM],
  ));
  const struct = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint256' }],
    [k('Mandate(address account,address payee,uint256 capPerPeriod,uint64 period,uint64 expiry,uint256 nonce)'), live.account, live.payee, live.capPerPeriod, live.period, live.expiry, live.nonce],
  ));
  assert.equal(keccak256(concat(['0x1901', domainSep, struct])), mandateDigest(live, MM, 1874));
  assert.notEqual(mandateDigest({ ...live, capPerPeriod: 2_000_001n }, MM, 1874), mandateDigest(live, MM, 1874));
});

test('createMandate / pull calldata and relayer body', () => {
  const abi = parseAbi([
    'function createMandate((address account,address payee,uint256 capPerPeriod,uint64 period,uint64 expiry,uint256 nonce) m, address[] approvers, bytes[] signatures)',
    'function pull(bytes32 mandateId, uint256 amount)',
  ]);
  assert.equal(encodeCreateMandate(live, approvals), encodeFunctionData({ abi, functionName: 'createMandate', args: [live, approvals.map((a) => a.approver), approvals.map((a) => a.signature)] }));
  const id = '0x08d47f1cfdc3adfe04d41ce6135822149f4440ebf88fdc6b34612c9049c2e574';
  assert.equal(encodePull(id, 500_000n), encodeFunctionData({ abi, functionName: 'pull', args: [id, 500_000n] }));
  assert.deepEqual(mandateRelayerBody(live, approvals).mandate, { account: live.account, payee: live.payee, capPerPeriod: '2000000', period: '2592000', expiry: '1801719053', nonce: '1' });
});

test('timings table holds the measured values with proof links', () => {
  const byAction = Object.fromEntries(TIMINGS.map((t) => [t.action, t]));
  assert.equal(byAction['Pay an approved invoice'].tazor, '3.6 s');
  assert.equal(byAction['Pay with our servers down (Ethereum fallback)'].tazor, '69 s via Ethereum');
  for (const t of TIMINGS.filter((x) => x.status === 'measured')) assert.ok(t.proof?.length, t.action);
  assert.equal(byAction['Remove a person'].tazor, '3.06 s');
  assert.ok(byAction['Remove a person'].proof?.[0].url.endsWith('0x027e1cfd06b86adaadab600b98b9444c98178c56ff038ef09daacb3df6ecd6ef'));
});
