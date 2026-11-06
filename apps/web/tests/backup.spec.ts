import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';

const WC_RPC = 'https://rpc.testnet.whitechain.io/';
const APPROVER_ACCOUNT = '0x000000000000000000000000000000000000a001';
const BACKUP = '0x000000000000000000000000000000000000b0b0';
const PAYMASTER = '0x0000000000000000000000000000000000007777';
const USEROP_HASH = `0x${'5e'.repeat(32)}`;
const TX = `0x${'ef'.repeat(32)}`;
const SEL = {
  webAuthnVerifier: toFunctionSelector('webAuthnVerifier()'),
  predictAddress: toFunctionSelector('predictAddress(bytes[])'),
  isSigner: toFunctionSelector('isSigner(bytes)'),
  getNonce: toFunctionSelector('getNonce(address,uint192)'),
  getUserOpHash: toFunctionSelector('getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))'),
};
const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v]);
const ok = (id: number, result: unknown) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });

async function setup(page: Page, userop: { status: number; body: unknown }) {
  const seen = { rpc: [] as { method: string; params: unknown[] }[], userop: null as null | { userOp: Record<string, string> }, mined: false };
  await page.route(WC_RPC, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    if (method === 'eth_getCode') return route.fulfill(ok(id, '0x6001'));
    if (method === 'eth_gasPrice') return route.fulfill(ok(id, '0x3b9aca00'));
    if (method === 'eth_getTransactionReceipt') { seen.mined = true; return route.fulfill(ok(id, { status: '0x1', blockNumber: '0x10', transactionHash: TX })); }
    const data: string = params?.[0]?.data ?? '';
    if (data.startsWith(SEL.webAuthnVerifier)) return route.fulfill(ok(id, word('address', '0x0000000000000000000000000000000000007002')));
    if (data.startsWith(SEL.predictAddress)) return route.fulfill(ok(id, word('address', APPROVER_ACCOUNT)));
    if (data.startsWith(SEL.isSigner)) return route.fulfill(ok(id, word('bool', seen.mined)));
    if (data.startsWith(SEL.getNonce)) return route.fulfill(ok(id, word('uint256', 7n)));
    if (data.startsWith(SEL.getUserOpHash)) return route.fulfill(ok(id, word('bytes32', USEROP_HASH)));
    return route.fulfill(ok(id, '0x'));
  });
  await page.route('http://relayer.test/approver', (route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ account: APPROVER_ACCOUNT, txHash: null }) }));
  await page.route('http://relayer.test/rpc', async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    seen.rpc.push({ method, params });
    const result = { paymaster: PAYMASTER, paymasterData: '0x', paymasterVerificationGasLimit: '0x30d40', paymasterPostOpGasLimit: '0x186a0', ...(method === 'pm_getPaymasterStubData' ? { verificationGasLimit: '0xf4240' } : {}) };
    await route.fulfill(ok(id, result));
  });
  await page.route('http://relayer.test/userop', async (route) => {
    seen.userop = route.request().postDataJSON();
    await route.fulfill({ status: userop.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(userop.body) });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto('/onboard/');
  await page.getByTestId('create').click();
  await expect(page.getByTestId('approver-account')).toHaveText(APPROVER_ACCOUNT);
  await page.goto('/company/');
  await page.getByTestId('eoa').fill(BACKUP);
  return seen;
}

test('add backup signer: sponsored userOp via ERC-7677 + /userop, then confirmed on-chain', async ({ page }) => {
  const seen = await setup(page, { status: 200, body: { txHash: TX } });
  await page.getByTestId('add-backup').click();
  await expect(page.getByTestId('backup-added')).toHaveText(' · Backup signer added', { timeout: 10_000 });
  await expect(page.getByTestId('backup-tx').locator('a')).toHaveAttribute('href', `https://explorer.testnet.whitechain.io/tx/${TX}`);

  expect(seen.rpc.map((r) => r.method)).toEqual(['pm_getPaymasterStubData', 'pm_getPaymasterData']);
  expect(seen.rpc[0].params[1]).toBe('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
  expect(seen.rpc[0].params[2]).toBe('0x752');
  const op = seen.userop!.userOp;
  expect(op.sender).toBe(APPROVER_ACCOUNT);
  expect(op.nonce).toBe('0x7');
  expect(op.paymaster).toBe(PAYMASTER);
  expect(op.verificationGasLimit).toBe('0xf4240');
  expect(op.callData.startsWith(toFunctionSelector('execute(bytes32,bytes)'))).toBe(true);
  expect(op.callData.toLowerCase()).toContain(BACKUP.slice(2).toLowerCase());
  expect(op.signature.length).toBeGreaterThan(1000);
});

test('a failing /userop shows a clear error, nothing silent', async ({ page }) => {
  await setup(page, { status: 422, body: { error: 'simulation reverted: SoulQuotaExceeded' } });
  await page.getByTestId('add-backup').click();
  await expect(page.getByTestId('backup-error')).toHaveText('relayer /userop failed (HTTP 422): simulation reverted: SoulQuotaExceeded');
  await expect(page.getByTestId('backup-tx')).toHaveCount(0);
});
