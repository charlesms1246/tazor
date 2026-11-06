import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';
import { invoiceHash } from '../lib/invoice.ts';
import {
  csvField, toCamt054, toQuickBooksCsv, toTallyCsv, toXeroCsv, usdt2dp, usdtExact, xmlEscape, type PaymentRecord,
} from '../lib/export.ts';

const ACME = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';
const TX = '0xbceeaa443a3e17a19037a677a459a88dcd11a7e17b01ebd431118c997ce84f21';
const payment: PaymentRecord = {
  invoice: {
    id: 'INV-7', supplierName: 'Bluejay "Logistics", LLP', supplierAccount: BLUEJAY, payee: BLUEJAY, buyerAccount: ACME,
    token: WHITECHAIN_SEPOLIA_USDT, amount: 1_200_000n, dueDate: 1798761600,
    lines: [{ description: 'Freight', quantity: 1n, unitPrice: 1_200_000n }], memo: 'PO 12\nrush & <fragile>',
  },
  txHash: TX,
  blockTimestamp: 1794000000,
};
const PARTY = '"Bluejay ""Logistics"", LLP (0xc1dce946D192e344251972470237F1471C93876c)"';
const NARR = '"Invoice INV-7 - PO 12\nrush & <fragile>"';

function assertWellFormedXml(xml: string) {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>|([^<]+)/g;
  let consumed = 0;
  for (const m of body.matchAll(re)) {
    assert.equal(m.index, consumed, `unexpected markup at ${consumed}`);
    consumed += m[0].length;
    if (m[5] !== undefined) {
      assert.doesNotMatch(m[5], /&(?!(amp|lt|gt|quot|apos);)/, 'bare &');
      if (!stack.length) assert.match(m[5], /^\s*$/, 'text outside the root');
      continue;
    }
    const [, close, name, , self] = m;
    if (close) assert.equal(stack.pop(), name, `mismatched </${name}>`);
    else if (!self) stack.push(name);
  }
  assert.equal(consumed, body.length, 'trailing garbage');
  assert.deepEqual(stack, [], 'unclosed elements');
}

test('csv escaping: commas, quotes, newlines', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('cr\rlf'), '"cr\rlf"');
  assert.equal(csvField(42), '42');
});

test('usdt amounts: 2 dp in CSV (half up), exact 6 dp in XML', () => {
  assert.equal(usdt2dp(1_200_000n), '1.20');
  assert.equal(usdt2dp(1_234_999n), '1.23');
  assert.equal(usdt2dp(1_235_000n), '1.24');
  assert.equal(usdt2dp(4_999n), '0.00');
  assert.equal(usdt2dp(-1_250_500_000n), '-1250.50');
  assert.equal(usdtExact(1_200_000n), '1.200000');
  assert.equal(usdtExact(1_234_567n), '1.234567');
  assert.equal(usdtExact(5n), '0.000005');
});

test('golden: Tally CSV', () => {
  assert.equal(toTallyCsv([payment], ACME),
    'Date,Voucher Type,Voucher Number,Party Ledger,Amount,Dr/Cr,Narration,Reference\r\n' +
    `06/11/2026,Payment,INV-7,${PARTY},1.20,Dr,${NARR},${TX}\r\n`);
});

test('golden: Xero CSV (signed amount, d/m/y)', () => {
  assert.equal(toXeroCsv([payment], ACME),
    '*Date,*Amount,Payee,Description,Reference,Cheque Number\r\n' +
    `06/11/2026,-1.20,${PARTY},${NARR},INV-7,\r\n`);
  assert.match(toXeroCsv([payment], BLUEJAY), /\r\n06\/11\/2026,1\.20,/);
});

test('golden: QuickBooks CSV (3-column, m/d/y)', () => {
  assert.equal(toQuickBooksCsv([payment], ACME),
    'Date,Description,Amount\r\n' +
    `11/06/2026,"Bluejay ""Logistics"", LLP (${BLUEJAY}): Invoice INV-7 - PO 12\nrush & <fragile> (${TX})",-1.20\r\n`);
});

test('golden: camt.054 entry, and the XML is well-formed', () => {
  const xml = toCamt054([payment], ACME, new Date('2026-11-06T12:00:00Z'));
  assertWellFormedXml(xml);
  assert.ok(xml.includes('<GrpHdr><MsgId>TAZOR-EA5A4Be3-20261106120000</MsgId><CreDtTm>2026-11-06T12:00:00Z</CreDtTm></GrpHdr>'));
  const entry = xml.slice(xml.indexOf('<Ntry>'), xml.indexOf('</Ntry>') + 7);
  assert.equal(entry,
    '<Ntry><Amt Ccy="USDT">1.200000</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>' +
    '<BookgDt><DtTm>2026-11-06T21:20:00Z</DtTm></BookgDt><ValDt><DtTm>2026-11-06T21:20:00Z</DtTm></ValDt>' +
    `<AcctSvcrRef>${TX}</AcctSvcrRef><BkTxCd><Prtry><Cd>USDT-TRANSFER</Cd><Issr>Whitechain</Issr></Prtry></BkTxCd>` +
    `<NtryDtls><TxDtls><Refs><AcctSvcrRef>${TX}</AcctSvcrRef><EndToEndId>INV-7</EndToEndId></Refs>` +
    '<Amt Ccy="USDT">1.200000</Amt><CdtDbtInd>DBIT</CdtDbtInd>' +
    `<RltdPties><Cdtr><Pty><Nm>Bluejay &quot;Logistics&quot;, LLP</Nm></Pty></Cdtr><CdtrAcct><Id><Othr><Id>${BLUEJAY}</Id></Othr></Id></CdtrAcct>` +
    `<DbtrAcct><Id><Othr><Id>${ACME}</Id></Othr></Id></DbtrAcct></RltdPties>` +
    `<RmtInf><Ustrd>${invoiceHash(payment.invoice)}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`);
  assert.equal(invoiceHash(payment.invoice), '0xb1be4d96706055d4881467605194f7a69d465678b6d6e7998f0af0864ae6eca4');
});

test('camt.054 escapes hostile text and stays well-formed; the checker rejects broken XML', () => {
  const evil = { ...payment, invoice: { ...payment.invoice, id: 'A&B</EndToEndId><x>', supplierName: "<O'Neil & Co>" } };
  const xml = toCamt054([evil, payment], ACME, new Date(0));
  assertWellFormedXml(xml);
  assert.ok(xml.includes('<EndToEndId>A&amp;B&lt;/EndToEndId&gt;&lt;x&gt;</EndToEndId>'));
  assert.equal(xml.match(/<Ntry>/g)?.length, 2);
  assert.equal(xmlEscape(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
  assert.throws(() => assertWellFormedXml('<a><b></a></b>'));
  assert.throws(() => assertWellFormedXml('<a>x & y</a>'));
});
