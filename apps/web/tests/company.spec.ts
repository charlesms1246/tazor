import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN } from '../lib/policies.ts';

const WC = 'https://rpc.testnet.whitechain.io/';
const SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com/';
const PRIYA = '0x00abed5bdddf794c415ee746d3e4de5332cc5450';
const CFO = '0x20ba842dc15cbcf4e02d8ce77e07391a949bb967';
const RAVI = '0xed7335f5ad5e60691b0d88a4b8921a65c7e4c3cb';
const MEERA = '0x03c291d446b870e0b8f128681937a9eceda97763';
const REGISTRY = '0x331bdb575a72fb3dd8a6c85b6c043a753340fbf1';
const SEL = Object.fromEntries(([
  'getSignerCount()', 'getSigners(uint64,uint64)', 'registryOf(address)', 'isRevoked(address,address)',
  'rolesOf(address,address)', 'roles(uint256,address)', 'soulOf(address)', 'soulAttributeValue(uint256,address)', 'number()',
] as const).map((s) => [s.split('(')[0], toFunctionSelector(s)]));
const arg = (data: string, i: number) => `0x${data.slice(10 + 64 * i + 24, 10 + 64 * (i + 1))}`.toLowerCase();
const enc = (types: string[], values: unknown[]) => encodeAbiParameters(types.map((type) => ({ type })), values);

// Mirrors the chain for the v2 demo account: Ravi's ENS role was removed but the role cache still holds it from
// L1 block 12,074,541 (~6 h before L1 block 12,076,303). CFO's mismatch is fresh (3 blocks), so it is a sync in flight.
// Meera's revocation is synthetic, to cover the Revoked pill.
const L1_NOW = 12_076_303n;
const ENS: Record<string, bigint> = { [PRIYA]: ROLE_APPROVER | ROLE_TAZOR_ADMIN, [CFO]: ROLE_APPROVER | ROLE_AGENT, [RAVI]: 0n, [MEERA]: ROLE_APPROVER };
const CACHE: Record<string, [bigint, bigint]> = {
  [PRIYA]: [ROLE_APPROVER | ROLE_TAZOR_ADMIN, 12_075_079n], [CFO]: [ROLE_APPROVER, 12_076_300n], [RAVI]: [ROLE_APPROVER, 12_074_541n], [MEERA]: [ROLE_APPROVER, 12_075_000n],
};
const REVOKED = new Set([MEERA]);

async function mock(page: Page) {
  // Real WB Soul is read from Whitechain mainnet; the demo people have no mainnet Soul.
  await page.route('https://rpc.whitechain.io/', async (route) => {
    const { id } = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result: enc(['uint256'], [0n]) }) });
  });
  const reply = (id: number, result?: Hex) => ({
    contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } } : { jsonrpc: '2.0', id, result }),
  });
  for (const url of [WC, SEPOLIA]) {
    await page.route(url, async (route) => {
      const { id, method, params } = route.request().postDataJSON();
      if (method !== 'eth_call') return route.fulfill(reply(id, '0x1'));
      const d: string = params[0].data;
      const s = d.slice(0, 10);
      if (s === SEL.getSignerCount) return route.fulfill(reply(id, enc(['uint256'], [1n])));
      if (s === SEL.getSigners) return route.fulfill(reply(id, enc(['bytes[]'], [[PRIYA]])));
      if (s === SEL.registryOf) return route.fulfill(reply(id, enc(['address'], [REGISTRY])));
      if (s === SEL.number) return route.fulfill(reply(id, enc(['uint64'], [L1_NOW])));
      if (s === SEL.isRevoked) return route.fulfill(reply(id, enc(['bool'], [REVOKED.has(arg(d, 1))])));
      if (s === SEL.rolesOf) return route.fulfill(reply(id, enc(['uint256', 'uint64'], CACHE[arg(d, 1)] ?? [0n, 0n])));
      if (s === SEL.roles) return route.fulfill(reply(id, enc(['uint256'], [ENS[arg(d, 1)] ?? 0n])));
      if (s === SEL.soulOf) return route.fulfill(reply(id, enc(['uint256'], [arg(d, 0) === MEERA ? 0n : 1n])));
      if (s === SEL.soulAttributeValue) return route.fulfill(reply(id, '0x0000000000000000000000000000000000000001000000000000000000000000'));
      return route.fulfill(reply(id));
    });
  }
}

test('company page: profile, people with roles, WB Soul and Whitechain status', async ({ page }) => {
  await mock(page);
  await page.goto('/company/');
  await expect(page.getByTestId('company-profile')).toContainText('acme.taz0r.eth');
  const rows = page.getByTestId('person-row');
  await expect(rows).toHaveCount(4);
  const row = (a: string) => page.locator(`[data-testid="person-row"][data-address="${a}"]`);
  await expect(row(PRIYA)).toContainText('Priya (Finance)');
  await expect(row(PRIYA)).toContainText('Approver');
  await expect(row(PRIYA)).toContainText('Admin');
  await expect(row(PRIYA).getByTestId('person-status')).toHaveText('In sync');
  await expect(row(CFO)).toContainText('Agent');
  await expect(row(CFO).getByTestId('person-status')).toHaveText('Syncing… ~1 min');
  await expect(row(RAVI).getByTestId('person-status')).toHaveText('Out of sync');
  await expect(row(RAVI).getByTestId('person-sync-note')).toContainText('Role cache last synced ~6 h ago (L1 block 12,074,541); run syncRoles.');
  await expect(row(RAVI).getByRole('link', { name: 'How to sync' })).toHaveAttribute('href', '/docs/company-on-ens/#how-a-role-change-reaches-whitechain');
  await expect(row(CFO).getByTestId('person-sync-note')).toHaveCount(0);
  await expect(row(MEERA).getByTestId('person-status')).toHaveText('Revoked');
  await expect(row(MEERA).getByTestId('soul-mirror-pill')).toHaveText('Not in the mirror');
  await expect(row(PRIYA).getByTestId('soul-mirror-pill')).toHaveText('Verified (simulated)');
  await expect(row(PRIYA).getByTestId('soul-mainnet-pill')).toHaveText('No Soul on mainnet');
  await expect(page.locator('[data-tour="people"]')).toBeVisible();
});

test('person drawer: ENS bitmap, ENS explorer link, registry events, Escape closes', async ({ page }) => {
  await mock(page);
  await page.goto('/company/');
  await expect(page.getByTestId('company-ens-links').getByRole('link', { name: 'Roles in ENS' })).toHaveAttribute('href', 'https://sepolia.explorer.ens.domains/acme.taz0r.eth/roles');
  await expect(page.getByTestId('registry-contract-link')).toHaveAttribute('href', `https://sepolia.etherscan.io/address/0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1#events`);
  await page.locator(`[data-testid="person-row"][data-address="${PRIYA}"]`).click();
  const drawer = page.getByTestId('person-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Priya (Finance)');
  await expect(drawer.getByTestId('person-ens-bitmap')).toHaveText(`0x${(ROLE_APPROVER | ROLE_TAZOR_ADMIN).toString(16)}`);
  await expect(drawer.getByTestId('person-ens-link')).toHaveAttribute('href', 'https://sepolia.explorer.ens.domains/0x00aBed5bDddf794c415eE746d3E4De5332cC5450');
  await expect(drawer.getByTestId('person-registry-events')).toHaveAttribute('href', /0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1#events$/);
  await expect(drawer.getByTestId('revoke-target')).toHaveValue('0x00aBed5bDddf794c415eE746d3E4De5332cC5450');
  await expect(drawer.getByTestId('soul-mirror-pill')).toHaveText('Verified (simulated)');
  await expect(drawer.getByRole('link', { name: 'Check any address against the real registry' })).toHaveAttribute('href', '/docs/wb-soul/');
  await expect(page.getByTestId('manage-access')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('manage-access')).toBeVisible();
});
