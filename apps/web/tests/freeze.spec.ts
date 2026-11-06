import { test, expect, type Page } from '@playwright/test';
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { revokeDigest } from '../lib/revoke.ts';
import { lc, routeRpc } from './rpc-mock.ts';

const PM2 = '0x906620D82e2959351c81D731C67EA46DF71E36f3';
const V1_LIST = '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e';
const V2_LIST = '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a';
const FACTORY = '0x0000000000000000000000000000000000007001';
const APPROVER = '0x000000000000000000000000000000000000a001';
const V1_CO = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6';
const V2_CO = '0xb99A12652BEe98429ae31EA0529A0b63f1073721';
const abi = parseAbi([
  'function revokeDigest(address account, address target, uint256 deadline) view returns (bytes32)',
  'function isRevoked(address account, address approver) view returns (bool)',
  'function revoke(address account, address target, address admin, uint256 deadline, bytes sig)',
  'function configV2Of(address) view returns ((address,uint96,uint96,uint96,uint32,uint96,uint32,uint96,address[],uint32))',
  'function webAuthnVerifier() view returns (address)',
  'function predictAddress(bytes[] signers) view returns (address)',
]);

async function setup(page: Page, posts: Record<string, unknown>[], revoked: { v: boolean }) {
  const list = (addr: Address) => [
    { abi, fn: 'revokeDigest', result: (a: readonly unknown[]) => revokeDigest({ account: a[0] as Address, target: a[1] as Address, deadline: a[2] as bigint }, addr, 1874) },
    { abi, fn: 'isRevoked', result: () => revoked.v },
  ];
  await routeRpc(page, 'https://rpc.testnet.whitechain.io/', {
    [lc(V1_LIST)]: list(V1_LIST),
    [lc(V2_LIST)]: list(V2_LIST),
    [lc(PM2)]: [{ abi, fn: 'configV2Of', result: (a) => [lc(a[0] as Address) === lc(V2_CO) ? '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1' : '0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0, 0n, 0, 0n, [], 0] }],
    [lc(FACTORY)]: [
      { abi, fn: 'webAuthnVerifier', result: () => '0x0000000000000000000000000000000000007002' },
      { abi, fn: 'predictAddress', result: () => APPROVER },
    ],
  });
  await page.route('http://relayer.test/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (route.request().url().endsWith('/revoke')) {
      posts.push(route.request().postDataJSON());
      revoked.v = true;
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ txHash: `0x${'ef'.repeat(32)}` }) });
    }
    return route.abort('connectionrefused');
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto('/onboard/');
  await page.getByTestId('create').click();
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER);
}

for (const [label, co, list] of [['v1', V1_CO, V1_LIST], ['v2', V2_CO, V2_LIST]] as const) {
  test(`freeze my device (${label}): confirm, self-revoke via relayer, then isRevoked`, async ({ page }) => {
    const posts: Record<string, unknown>[] = [];
    const revoked = { v: false };
    await setup(page, posts, revoked);
    await page.goto('/settings/');
    await page.getByTestId('freeze-account').fill(co);
    await page.getByTestId('freeze-prepare').click();
    await expect(page.getByTestId('freeze-confirm')).toContainText(list);
    expect(posts).toHaveLength(0);
    await page.getByTestId('freeze-yes').click();
    await expect(page.getByTestId('freeze-tx')).toContainText('0xefef');
    expect(posts).toHaveLength(1);
    const p = posts[0] as { account: string; target: string; admin: string; list?: string };
    expect(getAddress(p.account)).toBe(co);
    expect(getAddress(p.target)).toBe(APPROVER);
    expect(getAddress(p.admin)).toBe(APPROVER);
    expect(p.list ? getAddress(p.list) : undefined).toBe(label === 'v2' ? V2_LIST : undefined);
    const d = decodeFunctionData({ abi, data: (await page.getByTestId('freeze-calldata').textContent()) as Hex });
    expect(d.functionName).toBe('revoke');
    expect((d.args as unknown as unknown[]).slice(0, 3).map((x) => getAddress(x as string))).toEqual([co, APPROVER, APPROVER]);
    await page.getByTestId('freeze-check').click();
    await expect(page.getByTestId('freeze-status')).toContainText('Revoked');
  });
}
