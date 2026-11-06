import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type Hex } from 'viem';
import {
  buildTazorInvoice, createInvoiceLink, findPayment, getPayment, inputFromAttributes, isPaid, watchPayment, type ExplorerLog,
} from '../src/index.ts';
// the Tazor app's own code: a link made by the SDK must decode there to the identical invoice
import { decodeInvoiceLink } from '../../../apps/web/lib/invoice-link.ts';
import { invoiceHash, canonicalInvoiceJson } from '../../../apps/web/lib/invoice.ts';
import { splitTax } from '../../../apps/web/lib/invoices-store.ts';

const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';
const order = {
  supplierName: 'Bluejay Logistics', payee: BLUEJAY, buyerAccount: ACME, dueDate: '2026-12-31', memo: 'Order 1042', id: 'BJ-1042',
  lines: [
    { description: 'Freight Mumbai → Pune', quantity: 1, unitPrice: '1.20' },
    { description: 'Customs handling', quantity: '2', unitPrice: '0.15' },
    { description: 'Cargo insurance', unitPrice: '0.05' },
  ],
};

test('createInvoiceLink: the app decodes the link to the identical invoice, with the same hash', async () => {
  const l = await createInvoiceLink({ ...order, appUrl: 'https://tazor-app.vercel.app/' });
  assert.match(l.url, /^https:\/\/tazor-app\.vercel\.app\/pay\/#v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const decoded = await decodeInvoiceLink(l.url);
  assert.equal(canonicalInvoiceJson(decoded), canonicalInvoiceJson(l.invoice));
  assert.equal(l.invoiceHash, invoiceHash(decoded));
  assert.equal(l.id, 'BJ-1042');
  assert.equal(l.amount, '1.55');
  assert.equal(l.amountBaseUnits, 1_550_000n);
  assert.equal(decoded.supplierAccount, BLUEJAY, 'supplier account defaults to the payee');
  assert.equal(decoded.dueDate, Date.UTC(2026, 11, 31) / 1000);
  assert.deepEqual(decoded.lines.map((x) => [x.quantity, x.unitPrice]), [[1n, 1_200_000n], [2n, 150_000n], [1n, 50_000n]]);

  // same order, same id → same invoice hash (a fresh key each time, so the URL differs)
  const again = await createInvoiceLink(order);
  assert.equal(again.invoiceHash, l.invoiceHash);
  assert.notEqual(again.url, l.url);
  assert.ok(again.url.startsWith('https://app.tazor.charlesms.dev/pay/#v1.'), 'default app URL');
});

test('tax: a final "<label> <rate>%" line rounded half-up, which the app shows as tax again', async () => {
  const l = await createInvoiceLink({ ...order, lines: [{ description: 'Freight', unitPrice: '100' }], taxRate: 18, taxLabel: 'GST' });
  assert.equal(l.amount, '118');
  const last = l.invoice.lines.at(-1)!;
  assert.deepEqual([last.description, last.quantity, last.unitPrice], ['GST 18%', 1n, 18_000_000n]);
  assert.deepEqual(splitTax(l.invoice.lines).tax, { label: 'GST', rate: '18', amount: 18_000_000n });
  const tiny = buildTazorInvoice({ ...order, lines: [{ description: 'x', unitPrice: '0.000005' }], taxRate: '10' });
  assert.equal(tiny.amount, 6n, '0.5 base units rounds up');
  assert.equal(buildTazorInvoice({ ...order, taxRate: 0 }).lines.length, 3, 'no line for 0 %');
});

test('validation is the app’s: bad addresses, prices and tax rates throw with its messages', () => {
  assert.throws(() => buildTazorInvoice({ ...order, payee: 'bluejay' }), /Payee must be a Whitechain address/);
  assert.throws(() => buildTazorInvoice({ ...order, buyerAccount: '' }), /Customer company account must be a Whitechain address/);
  assert.throws(() => buildTazorInvoice({ ...order, lines: [{ description: 'x', unitPrice: '1.2345678' }] }), /unit price must be a USDT amount/);
  assert.throws(() => buildTazorInvoice({ ...order, taxRate: '101' }), /taxRate must be/);
  assert.throws(() => buildTazorInvoice({ ...order, dueDate: '31/12/2026' }), /dueDate must be/);
  const d = Date.UTC(2026, 11, 31) / 1000;
  for (const due of ['2026-12-31', new Date(d * 1000 + 3_600_000), d]) assert.equal(buildTazorInvoice({ ...order, dueDate: due }).dueDate, d);
});

// ---- payment detection

const fixture = JSON.parse(readFileSync(new URL('../../../apps/web/tests/fixtures/chain-logs.json', import.meta.url), 'utf8'));
const evAbi = parseAbi(['event InvoicePaid(address indexed account, uint256 indexed nonce, address payee, uint256 amount, bool viaL1)']);
const paidLog = (hash: Hex, payee: Hex = BLUEJAY, amount = 1_550_000n, tx = `0x${'cd'.repeat(32)}` as Hex): ExplorerLog => ({
  block_timestamp: '2026-11-06T10:00:00.000000Z', transaction_hash: tx,
  topics: [...encodeEventTopics({ abi: evAbi, eventName: 'InvoicePaid', args: { account: ACME, nonce: BigInt(hash) } }), null] as ExplorerLog['topics'],
  data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [payee, amount, false]),
});

test('findPayment: matches InvoicePaid by nonce == invoice hash in real recorded Blockscout logs', () => {
  const logs: ExplorerLog[] = [...fixture.PM1.items, ...fixture.PM2.items];
  const real = fixture.PM2.items.find((l: ExplorerLog) => l.transaction_hash.startsWith('0x6402d161'));
  const p = findPayment(logs, real.topics[2])!;
  assert.equal(p.txHash, real.transaction_hash);
  assert.equal(p.amount, '0.1');
  assert.equal(p.amountBaseUnits, 100_000n);
  assert.equal(p.payer, ACME);
  assert.equal(p.payee, BLUEJAY);
  assert.equal(p.at, Date.parse('2026-11-06T08:56:25.000000Z'));
  assert.equal(p.viaL1, false);
  assert.equal(findPayment(logs, real.topics[2], ACME), null, 'payee must match when given');
  assert.equal(findPayment(logs, `0x${'77'.repeat(32)}`), null);
  // other PM2 events with a third topic are never decoded as payments: a ProvisionalGranted grantee finds nothing, and an
  // AgentPaid nonce finds only the real InvoicePaid of the same invoice in the same transaction
  const isPaidLog = (l: ExplorerLog) => l.topics[0]!.startsWith('0x7a05aaf7');
  const others: ExplorerLog[] = fixture.PM2.items.filter((l: ExplorerLog) => l.topics[2] && !isPaidLog(l));
  assert.ok(others.length >= 3);
  let none = 0;
  for (const g of others) {
    const hit = findPayment(logs, g.topics[2]!);
    if (!hit) { none++; continue; }
    assert.ok(logs.some((x) => isPaidLog(x) && x.topics[2] === g.topics[2] && x.transaction_hash === hit.txHash), 'a real InvoicePaid');
  }
  assert.ok(none >= 2, 'ProvisionalGranted grantees match nothing');
});

test('getPayment / isPaid read both PaymentModules from the explorer; watchPayment polls until paid, then stops', async () => {
  const l = await createInvoiceLink(order);
  const urls: string[] = [];
  let paidAfter = 2;
  let calls = 0;
  const f = (async (url: string) => {
    urls.push(url);
    if (url.includes('0x906620D82e2959351c81D731C67EA46DF71E36f3')) calls++;
    const items = url.includes('0x906620D82e2959351c81D731C67EA46DF71E36f3') && calls > paidAfter ? [paidLog(l.invoiceHash)] : fixture.PM1.items;
    return new Response(JSON.stringify({ items }));
  }) as typeof fetch;

  assert.equal(await isPaid(l.invoiceHash, { fetch: f }), false);
  assert.deepEqual(urls.slice(0, 2).sort(), [
    'https://explorer.testnet.whitechain.io/api/v2/addresses/0x906620D82e2959351c81D731C67EA46DF71E36f3/logs',
    'https://explorer.testnet.whitechain.io/api/v2/addresses/0xe19ddf1fd417B146137A5dE6eb56c4589431540A/logs',
  ]);

  const paid: unknown[] = [];
  const errors: Error[] = [];
  await new Promise<void>((resolve) => {
    const stop = watchPayment({
      invoiceHash: l.invoiceHash, payee: BLUEJAY, fetch: f, intervalMs: 5,
      onPaid: (p) => { paid.push(p); setTimeout(resolve, 30); },
      onError: (e) => errors.push(e),
    });
    void stop;
  });
  assert.equal(paid.length, 1, 'onPaid fires once');
  const p = paid[0] as { txHash: string; amount: string; invoiceHash: string; explorerUrl: string };
  assert.equal(p.amount, '1.55');
  assert.equal(p.invoiceHash, l.invoiceHash);
  assert.equal(p.explorerUrl, `https://explorer.testnet.whitechain.io/tx/0x${'cd'.repeat(32)}`);
  const n = calls;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, n, 'no polling after paid');
  assert.equal(errors.length, 0);
  assert.equal((await getPayment(l.invoiceHash, { fetch: f }))?.txHash, `0x${'cd'.repeat(32)}`);

  // explorer errors are reported and polling continues; stop() ends it
  const failing = (async () => new Response('down', { status: 503 })) as typeof fetch;
  const errs: string[] = [];
  const stop = watchPayment({ invoiceHash: l.invoiceHash, fetch: failing, intervalMs: 5, onPaid: () => assert.fail('not paid'), onError: (e) => errs.push(e.message) });
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const seen = errs.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(seen >= 2 && errs.every((m) => m === 'explorer returned 503'));
  assert.equal(errs.length, seen, 'stopped');
  assert.equal(toHex(BigInt(l.invoiceHash), { size: 32 }), l.invoiceHash.toLowerCase());
});

test('<tazor-pay-button> attributes: lines JSON, or a single amount; required attributes are named', () => {
  const attrs = (o: Record<string, string>) => (n: string) => o[n] ?? null;
  const base = { 'supplier-name': 'Bluejay Logistics', payee: BLUEJAY, buyer: ACME, due: '2026-12-31', 'invoice-id': 'BJ-1' };
  const one = inputFromAttributes(attrs({ ...base, amount: '12.50', memo: 'Order 7' }));
  assert.deepEqual(one.lines, [{ description: 'Order 7', quantity: 1, unitPrice: '12.50' }]);
  assert.equal(buildTazorInvoice(one).amount, 12_500_000n);
  const many = inputFromAttributes(attrs({ ...base, lines: JSON.stringify(order.lines), 'tax-rate': '18', 'tax-label': 'GST' }));
  assert.equal(buildTazorInvoice(many).lines.at(-1)!.description, 'GST 18%');
  assert.throws(() => inputFromAttributes(attrs({ ...base, amount: '1', payee: '' })), /needs the payee attribute/);
  assert.throws(() => inputFromAttributes(attrs({ ...base, lines: '[{' })), /lines must be JSON/);
  assert.throws(() => inputFromAttributes(attrs(base)), /needs the amount attribute/);
  assert.match(inputFromAttributes(attrs({ ...base, due: '', amount: '1' })).dueDate as string, /^\d{4}-\d{2}-\d{2}$/, 'due defaults to +14 days');
});

test('dist/tazor-pay.js (IIFE) loads without a DOM and exposes window.TazorPay', { skip: !existsSync(new URL('../dist/tazor-pay.js', import.meta.url)) }, async () => {
  const ctx: Record<string, unknown> = { crypto, TextEncoder, TextDecoder, btoa, atob, fetch, setTimeout, clearTimeout, console, Date };
  ctx.globalThis = ctx;
  runInNewContext(readFileSync(new URL('../dist/tazor-pay.js', import.meta.url), 'utf8'), ctx);
  const api = ctx.TazorPay as { createInvoiceLink: typeof createInvoiceLink };
  assert.equal(typeof api.createInvoiceLink, 'function');
  const l = await api.createInvoiceLink(order);
  assert.equal(canonicalInvoiceJson(await decodeInvoiceLink(l.url)), canonicalInvoiceJson(l.invoice));
});
