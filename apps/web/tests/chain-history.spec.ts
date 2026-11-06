import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, encodeEventTopics, toHex } from 'viem';
import { historyAbi, historySources, mapLogs, type BlockscoutLog } from '../lib/chain-history.ts';
import { canonicalInvoiceJson, invoiceHash, type Invoice } from '../lib/invoice.ts';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';
import { fixtureLogs, mockExplorer } from './explorer-mock.ts';

const ACME = '0xb99A12652BEe98429ae31EA0529A0b63f1073721' as const;
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c' as const;
const FX: Record<string, string> = {
  PaymentModule: 'PM1', PaymentModuleV2: 'PM2', MandateModule: 'MM1', MandateModuleV2: 'MM2', RevocationList: 'RL1',
  RevocationListV2: 'RL2', RoleCache: 'RC', EnsGate: 'G1', EnsGateV2: 'G2',
};
const fx = fixtureLogs();
const recorded = () => Object.fromEntries(historySources().map((s) => [s.contract, [...fx[FX[s.name]].items]]));

const mockRpc = async (page: Page) => {
  await page.route('https://rpc.testnet.whitechain.io/', (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
  await page.route('https://ethereum-sepolia-rpc.publicnode.com/', (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) }));
};

const invoice: Invoice = {
  id: 'INV-20261106-C0DE', supplierName: 'Bluejay Logistics', supplierAccount: BLUEJAY, payee: BLUEJAY, buyerAccount: ACME,
  token: WHITECHAIN_SEPOLIA_USDT, amount: 2_500_000n, dueDate: 1798761600,
  lines: [{ description: 'Freight', quantity: 1n, unitPrice: 2_500_000n }], memo: 'PO 12',
};
const PAID_TX = `0x${'ab'.repeat(32)}` as const;
/** An InvoicePaid log for `invoice`, encoded exactly as PaymentModuleV2 emits it. */
const paidLog = (): BlockscoutLog => ({
  block_number: 12_400_000, block_timestamp: '2026-11-06T10:00:00.000000Z', transaction_hash: PAID_TX, index: 0,
  topics: [...encodeEventTopics({ abi: historyAbi, eventName: 'InvoicePaid', args: { account: ACME, nonce: BigInt(invoiceHash(invoice)) } }), null] as BlockscoutLog['topics'],
  data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [BLUEJAY, invoice.amount, false]),
});

test('Approvals ▸ Paid lists what Acme paid on chain, with no device data', async ({ page }) => {
  await mockRpc(page);
  await mockExplorer(page, recorded());
  const expected = new Set(mapLogs(historySources().map((src) => ({ src, logs: fx[FX[src.name]].items as BlockscoutLog[] })), { account: ACME })
    .filter((e) => e.kind === 'paid' && e.payer?.toLowerCase() === ACME.toLowerCase()).map((e) => e.subject)).size;
  expect(expected).toBeGreaterThan(1);

  await page.goto('/approvals/');
  await expect(page.getByTestId('approvals-chain')).toContainText('payments by Acme Industries found on chain');
  await expect(page.getByTestId('approvals-count-paid')).toHaveText(String(expected));
  await expect(page.getByTestId('approvals-count-needs-approval')).toHaveText('0');
  await page.getByTestId('approvals-tab-paid').click();
  const rows = page.getByTestId('approval-row');
  await expect(rows).toHaveCount(expected);
  await expect(rows.first()).toHaveAttribute('data-source', 'chain');
  await expect(rows.first().getByTestId('approval-onchain')).toHaveText('on-chain');
  await expect(rows.first()).toContainText('Bluejay Logistics');
  await expect(rows.first().getByTestId('approval-tx')).toHaveAttribute('href', /^https:\/\/explorer\.testnet\.whitechain\.io\/tx\/0x[0-9a-f]{64}$/);
});

test('a payment made on another device shows on /pay/ and in the invoice drawer as paid, on-chain', async ({ page }) => {
  await mockRpc(page);
  await mockExplorer(page, { [historySources().find((s) => s.name === 'PaymentModuleV2')!.contract]: [paidLog()] });
  const link = await encodeInvoiceLink(invoice, 'http://localhost:4173');
  await page.addInitScript(([inv, l]) => localStorage.setItem('tazor.invoices.v1', JSON.stringify([{ invoice: inv, link: l, createdAt: 1793952000 }])), [canonicalInvoiceJson(invoice), link]);

  await page.goto(link.replace('http://localhost:4173', ''));
  const tl = page.getByTestId('pay-timeline');
  await expect(tl.locator('li[data-kind="paid"]')).toContainText('INV-20261106-C0DE paid: 2.5 USDT from Acme Industries to Bluejay Logistics');
  await expect(tl.locator('li[data-kind="paid"]')).toContainText('on-chain');
  await expect(tl.locator('li[data-kind="paid"] a')).toHaveAttribute('href', `https://explorer.testnet.whitechain.io/tx/${PAID_TX}`);
  await expect(tl.locator('li[data-tone="pending"]')).toHaveCount(0);
  await expect(page.getByTestId('paper-stamp')).toHaveText('PAID');
  await expect(page.getByTestId('pay-timeline-chain')).toHaveText('1 event read from the chain (marked on-chain).');

  await page.goto('/invoices/');
  await expect(page.getByTestId('inv-status')).toHaveText('Paid');
  await expect(page.getByTestId('inv-tab-count-paid')).toHaveText('1');
  await page.getByTestId('inv-row').click();
  const drawer = page.getByTestId('inv-drawer');
  await expect(drawer.getByTestId('paper-stamp')).toHaveText('PAID');
  await expect(drawer.getByTestId('inv-timeline').locator('li[data-kind="paid"]')).toContainText('on-chain');
  expect(toHex(BigInt(invoiceHash(invoice)), { size: 32 })).toBe(invoiceHash(invoice).toLowerCase());
});

test('when the explorers are down the pages still work and say so', async ({ page }) => {
  await mockRpc(page);
  for (const host of ['https://explorer.testnet.whitechain.io/api/v2/**', 'https://eth-sepolia.blockscout.com/api/v2/**']) {
    await page.route(host, (route) => route.fulfill({ status: 503, body: 'down' }));
  }
  await page.goto('/approvals/');
  await expect(page.getByTestId('approvals-chain')).toContainText('0 payments by Acme Industries found on chain (skipped: PaymentModule, PaymentModuleV2');
  await expect(page.getByTestId('approval-empty')).toBeVisible();
});
