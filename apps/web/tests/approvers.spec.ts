import { test, expect } from '@playwright/test';
import { parseAbi, type Address } from 'viem';
import { lc, routeRpc } from './rpc-mock.ts';

const PM = '0x0000000000000000000000000000000000007000';
const PM2 = '0x906620D82e2959351c81D731C67EA46DF71E36f3';
const V1_LIST = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e';
const V2_LIST = '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a';
const ROLE_CACHE = '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe';
const L1_BLOCK = '0x4200000000000000000000000000000000000015';
const REGISTRY = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1';
const V2_CO = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const V1_CO = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const RAVI = '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb';     // revoked on Whitechain, ENS still lists him
const PRIYA = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';    // ENS gained admin, cache still approver-only
const CFO = '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967';      // in sync
const APPROVER = 1n << 64n, ADMIN = 1n << 68n;
const abi = parseAbi([
  'function configV2Of(address) view returns ((address,uint96,uint96,uint96,uint32,uint96,uint32,uint96,address[],uint32))',
  'function windowAvailable(address) view returns (uint256, uint256)',
  'function pendingExit(address) view returns (address, uint64)',
  'function registryOf(address account) view returns (address)',
  'function getSignerCount() view returns (uint256)',
  'function getSigners(uint64 start, uint64 end) view returns (bytes[])',
  'function isRevoked(address account, address approver) view returns (bool)',
  'function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)',
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function number() view returns (uint64)',
]);
const cache: Record<string, [bigint, bigint]> = { [lc(RAVI)]: [APPROVER, 900n], [lc(PRIYA)]: [APPROVER, 950n], [lc(CFO)]: [APPROVER, 990n] };
const ens: Record<string, bigint> = { [lc(RAVI)]: APPROVER, [lc(PRIYA)]: APPROVER | ADMIN, [lc(CFO)]: APPROVER };
const zeroCfg = ['0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0, 0n, 0, 0n, [], 0];

async function mock(page: import('@playwright/test').Page, v2: boolean) {
  const company = v2 ? V2_CO : V1_CO;
  const list = v2 ? V2_LIST : V1_LIST;
  await routeRpc(page, 'https://rpc.testnet.whitechain.io/', {
    [lc(PM2)]: [
      { abi, fn: 'configV2Of', result: () => v2 ? [REGISTRY, 5_000_000n, 8_000_000n, 20_000_000n, 120, 3_000_000n, 300, 3_000_000n, [], 0] : zeroCfg },
      { abi, fn: 'windowAvailable', result: () => [0n, 0n] },
      { abi, fn: 'pendingExit', result: () => ['0x0000000000000000000000000000000000000000', 0n] },
    ],
    [lc(PM)]: [{ abi, fn: 'registryOf', result: () => (v2 ? '0x0000000000000000000000000000000000000000' : REGISTRY) }],
    [lc(company)]: [
      { abi, fn: 'getSignerCount', result: () => 2n },
      { abi, fn: 'getSigners', result: () => [PRIYA, CFO] },
    ],
    [lc(list)]: [{ abi, fn: 'isRevoked', result: (a) => lc(a[1] as Address) === lc(RAVI) }],
    [lc(ROLE_CACHE)]: [{ abi, fn: 'rolesOf', result: (a) => cache[lc(a[1] as Address)] ?? [0n, 0n] }],
    [lc(L1_BLOCK)]: [{ abi, fn: 'number', result: () => 1000n }],
  });
  await routeRpc(page, 'https://ethereum-sepolia-rpc.publicnode.com/', {
    [lc(REGISTRY)]: [{ abi, fn: 'roles', result: (a) => ens[lc(a[1] as Address)] ?? 0n }],
  });
}

for (const v2 of [true, false]) {
  test(`/policies/ approvers panel flags mirror-pending and sync-pending (${v2 ? 'v2' : 'v1'} account)`, async ({ page }) => {
    await mock(page, v2);
    await page.goto('/policies/');
    await page.getByTestId('account').fill(v2 ? V2_CO : V1_CO);
    await page.getByTestId('load').click();
    if (!v2) await expect(page.getByTestId('v1-account')).toBeVisible();
    // Ravi is not a signer: track him locally
    await page.getByTestId('approver-add').fill(RAVI);
    await page.getByTestId('approver-add-btn').click();
    const row = (a: string) => page.getByTestId(`approver-${a.toLowerCase()}`);
    await expect(row(RAVI)).toContainText('revoked');
    await expect(row(RAVI).getByTestId('approver-flags')).toHaveText('Revoked on Whitechain but still listed on ENS (mirror pending)');
    await expect(row(PRIYA)).toContainText('(admin signer)');
    await expect(row(PRIYA)).toContainText('50 blocks old');
    await expect(row(PRIYA).getByTestId('approver-flags')).toHaveText('ENS role changed, cache stale (sync pending)');
    await expect(row(CFO).getByTestId('approver-flags')).toHaveText('in sync');
  });
}
