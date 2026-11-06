import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/** Blockscout v2 log endpoints (Whitechain testnet and Sepolia) answered from a map of contract → items; anything else is empty. */
export async function mockExplorer(page: Page, byContract: Record<string, unknown[]> = {}) {
  const lower = Object.fromEntries(Object.entries(byContract).map(([k, v]) => [k.toLowerCase(), v]));
  for (const host of ['https://explorer.testnet.whitechain.io/api/v2/**', 'https://eth-sepolia.blockscout.com/api/v2/**']) {
    await page.route(host, (route) => {
      const m = /\/addresses\/(0x[0-9a-fA-F]{40})\/logs/.exec(route.request().url());
      const items = m ? lower[m[1].toLowerCase()] ?? [] : [];
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ items, next_page_params: null }) });
    });
  }
}

/** The recorded fixture logs (tests/fixtures/chain-logs.json), keyed by fixture name. */
export const fixtureLogs = (): Record<string, { items: unknown[] }> =>
  JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8'));
