import { test, expect, type Page } from '@playwright/test';
import { encodeFunctionResult, toFunctionSelector, type Hex } from 'viem';
import { encodeInvoiceLink } from '../lib/invoice-link.ts';
import { WHITECHAIN_SEPOLIA_USDT } from '../lib/invoice-auth.ts';
import { soulAbi } from '../lib/soul.ts';
import type { Invoice } from '../lib/invoice.ts';

const RPC = 'https://rpc.testnet.whitechain.io/';
const SUPPLIER = '0xc1dce946D192e344251972470237F1471C93876c';
const ADMIN = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const invoice: Invoice = {
  id: 'INV-B-1', supplierName: 'Bluejay', supplierAccount: SUPPLIER, payee: SUPPLIER,
  buyerAccount: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6', token: WHITECHAIN_SEPOLIA_USDT, amount: 1_000_000n,
  dueDate: 1798761600, lines: [{ description: 'x', quantity: 1n, unitPrice: 1_000_000n }], memo: '',
};
const SEL = Object.fromEntries((['registryOf(address)', 'getSigners(uint64,uint64)', 'soulOf(address)', 'soulAttributeValue(uint256,address)'] as const)
  .map((s) => [s.split('(')[0], toFunctionSelector(s)]));

async function mock(page: Page, verifiedValue: Hex) {
  await page.route(RPC, async (route) => {
    const { id, params } = route.request().postDataJSON();
    const data: string = params?.[0]?.data ?? '';
    const r = (functionName: string, result: unknown) => encodeFunctionResult({ abi: soulAbi, functionName, result } as never);
    let result: Hex | undefined;
    if (data.startsWith(SEL.registryOf)) result = r('registryOf', '0x2A582b9cFD4C20921C467512B7ebA41204d9a16b');
    else if (data.startsWith(SEL.getSigners)) result = r('getSigners', [ADMIN.toLowerCase()]);
    else if (data.startsWith(SEL.soulOf)) result = r('soulOf', 1n);
    else if (data.startsWith(SEL.soulAttributeValue)) result = r('soulAttributeValue', verifiedValue);
    await route.fulfill({
      contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(result ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } }),
    });
  });
}

const open = async (page: Page) => page.goto((await encodeInvoiceLink(invoice, 'http://x')).replace('http://x', ''));

test('buyer sees the WhiteBIT badge when a supplier admin is a verified soul', async ({ page }) => {
  await mock(page, '0x0000000000000000000000000000000000000001');
  await open(page);
  await expect(page.getByTestId('supplier-verified')).toHaveText('✓ Verified by WhiteBIT (simulated on testnet)');
});

test('buyer sees "Not verified" when no admin is verified', async ({ page }) => {
  await mock(page, '0x0000000000000000000000000000000000000000');
  await open(page);
  await expect(page.getByTestId('supplier-unverified')).toHaveText('Not verified');
  await expect(page.getByTestId('supplier-verified')).toHaveCount(0);
});
