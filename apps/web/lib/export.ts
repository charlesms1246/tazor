import { formatUnits } from 'viem';
import type { Invoice } from './invoice.ts';
import { invoiceHash } from './invoice.ts';

export type PaymentRecord = { invoice: Invoice; txHash: `0x${string}`; blockTimestamp: number };

const USDT_DECIMALS = 6;

export function usdt2dp(base: bigint): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const cents = (abs + 5_000n) / 10_000n;
  const s = `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  return neg && cents !== 0n ? `-${s}` : s;
}

export const usdtExact = (base: bigint) => {
  const [i, f = ''] = formatUnits(base < 0n ? -base : base, USDT_DECIMALS).split('.');
  return `${i}.${f.padEnd(USDT_DECIMALS, '0')}`;
};

export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (header: string[], rows: (string | number)[][]) =>
  [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

const isoDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const dmy = (ts: number) => { const [y, m, d] = isoDate(ts).split('-'); return `${d}/${m}/${y}`; };
const mdy = (ts: number) => { const [y, m, d] = isoDate(ts).split('-'); return `${m}/${d}/${y}`; };

function signed(p: PaymentRecord, account: string): bigint {
  return p.invoice.buyerAccount.toLowerCase() === account.toLowerCase() ? -p.invoice.amount : p.invoice.amount;
}
const counterparty = (p: PaymentRecord, account: string) =>
  p.invoice.buyerAccount.toLowerCase() === account.toLowerCase() ? `${p.invoice.supplierName} (${p.invoice.payee})` : p.invoice.buyerAccount;
const narration = (p: PaymentRecord) => `Invoice ${p.invoice.id}${p.invoice.memo ? ` - ${p.invoice.memo}` : ''}`;

export const toXeroCsv = (payments: PaymentRecord[], account: string) =>
  csv(['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Cheque Number'],
    payments.map((p) => [dmy(p.blockTimestamp), usdt2dp(signed(p, account)), counterparty(p, account), narration(p), p.invoice.id, '']));

export const toQuickBooksCsv = (payments: PaymentRecord[], account: string) =>
  csv(['Date', 'Description', 'Amount'],
    payments.map((p) => [mdy(p.blockTimestamp), `${counterparty(p, account)}: ${narration(p)} (${p.txHash})`, usdt2dp(signed(p, account))]));

export const toTallyCsv = (payments: PaymentRecord[], account: string) =>
  csv(['Date', 'Voucher Type', 'Voucher Number', 'Party Ledger', 'Amount', 'Dr/Cr', 'Narration', 'Reference'],
    payments.map((p) => {
      const out = signed(p, account) < 0n;
      return [dmy(p.blockTimestamp), out ? 'Payment' : 'Receipt', p.invoice.id, counterparty(p, account),
        usdt2dp(p.invoice.amount), out ? 'Dr' : 'Cr', narration(p), p.txHash];
    }));

export const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function toCamt054(payments: PaymentRecord[], account: string, createdAt = new Date()): string {
  const e = xmlEscape;
  const created = createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const msgId = `TAZOR-${account.slice(2, 10)}-${created.replace(/\D/g, '')}`;
  const entries = payments.map((p) => {
    const amt = signed(p, account);
    const ind = amt < 0n ? 'DBIT' : 'CRDT';
    const dt = new Date(p.blockTimestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const value = `<Amt Ccy="USDT">${usdtExact(amt)}</Amt>`;
    return [
      '<Ntry>', value, `<CdtDbtInd>${ind}</CdtDbtInd>`, '<Sts><Cd>BOOK</Cd></Sts>',
      `<BookgDt><DtTm>${dt}</DtTm></BookgDt>`, `<ValDt><DtTm>${dt}</DtTm></ValDt>`,
      `<AcctSvcrRef>${e(p.txHash)}</AcctSvcrRef>`,
      '<BkTxCd><Prtry><Cd>USDT-TRANSFER</Cd><Issr>Whitechain</Issr></Prtry></BkTxCd>',
      '<NtryDtls><TxDtls>',
      `<Refs><AcctSvcrRef>${e(p.txHash)}</AcctSvcrRef><EndToEndId>${e(p.invoice.id)}</EndToEndId></Refs>`,
      value, `<CdtDbtInd>${ind}</CdtDbtInd>`,
      `<RltdPties><Cdtr><Pty><Nm>${e(p.invoice.supplierName)}</Nm></Pty></Cdtr><CdtrAcct><Id><Othr><Id>${e(p.invoice.payee)}</Id></Othr></Id></CdtrAcct>`,
      `<DbtrAcct><Id><Othr><Id>${e(p.invoice.buyerAccount)}</Id></Othr></Id></DbtrAcct></RltdPties>`,
      `<RmtInf><Ustrd>${e(invoiceHash(p.invoice))}</Ustrd></RmtInf>`,
      '</TxDtls></NtryDtls>', '</Ntry>',
    ].join('');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08">',
    '<BkToCstmrDbtCdtNtfctn>',
    `<GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>${created}</CreDtTm></GrpHdr>`,
    `<Ntfctn><Id>${msgId}-1</Id><CreDtTm>${created}</CreDtTm>`,
    `<Acct><Id><Othr><Id>${e(account)}</Id></Othr></Id><Ccy>USDT</Ccy></Acct>`,
    ...entries,
    '</Ntfctn>',
    '</BkToCstmrDbtCdtNtfctn>',
    '</Document>',
    '',
  ].join('\n');
}
