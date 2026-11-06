import { test, expect } from '@playwright/test';

const WC = 'https://rpc.testnet.whitechain.io/';
const SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com/';

test('security page: four health rows, relayer up, fallback Ready', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const json = (id: number, result: unknown) => ({
    contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  await page.route('http://relayer.test/health', (route) => route.fulfill({
    contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, relayer: '0x000000000000000000000000000000000000beef' }),
  }));
  await page.route(WC, async (route) => {
    const { id, method } = route.request().postDataJSON();
    if (method === 'eth_getBlockByNumber') return route.fulfill(json(id, { number: '0xbc614e', timestamp: `0x${(now - 2).toString(16)}` }));
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } }) });
  });
  await page.route(SEPOLIA, async (route) => {
    const { id, method } = route.request().postDataJSON();
    if (method === 'eth_blockNumber') return route.fulfill(json(id, '0xb83cc3'));
    if (method === 'eth_getCode') return route.fulfill(json(id, '0x6080604052'));
    return route.fulfill(json(id, '0x'));
  });

  await page.goto('/security/');
  await expect(page.getByTestId('health-row')).toHaveCount(4);
  await expect(page.getByTestId('health-relayer')).toHaveText('Up');
  await expect(page.getByTestId('health-whitechain')).toHaveText('Up');
  await expect(page.getByTestId('health-ethereum')).toHaveText('Up');
  await expect(page.getByTestId('health-fallback')).toHaveText('Ready');
  await expect(page.getByTestId('health-row').filter({ hasText: 'Whitechain Sepolia' })).toContainText('block 12,345,678');
  await expect(page.locator('[data-tour="health"]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'How the fallback works' })).toHaveAttribute('href', '/docs/censorship-resistance/');
  await expect(page.getByTestId('freeze-account')).toBeVisible();
});
