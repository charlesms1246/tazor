import type { Page } from '@playwright/test';
import {
  concat, decodeFunctionData, domainSeparator, encodeAbiParameters, encodeFunctionResult, keccak256, toFunctionSelector, type Address, type Hex,
} from 'viem';
import { paymentModuleV2Abi } from '../lib/abi/PaymentModuleV2.ts';
import { financingModuleAbi } from '../lib/abi/FinancingModule.ts';
import { financedDigest } from '../lib/financing.ts';
import { invoiceAuthDigestV2 } from '../lib/policies.ts';
import { mandateModuleAbi } from '../lib/abi/MandateModule.ts';
import { mandateDigest } from '../lib/mandate.ts';

export const WC_RPC = 'https://rpc.testnet.whitechain.io/';
export const PM2: Address = '0x906620D82e2959351c81D731C67EA46DF71E36f3';
export const FM: Address = '0x7BEBCFC47be110a0175452456267bFdaD45DdE8B';
export const MM2: Address = '0x24b6eC6f6bf7e58bB3266b0b2701aE451ab7220F';
export const VERIFIER: Address = '0x0000000000000000000000000000000000007002';
export const APPROVER_ACCOUNT: Address = '0x000000000000000000000000000000000000a001';

const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v]);
const SEL = {
  webAuthnVerifier: toFunctionSelector('webAuthnVerifier()'),
  predictAddress: toFunctionSelector('predictAddress(bytes[])'),
};

export type V2State = {
  config?: Record<string, unknown>;
  window?: readonly [bigint, bigint];
  pendingExit?: readonly [Address, bigint];
  payeeAddedAt?: bigint;
  claim?: readonly [Address, bigint, bigint];
  listing?: bigint;
  owner?: Address;
  /** MandateModuleV2 calls seen (function names), for the v2 mandate spec */
  mm2Calls?: string[];
};

/** Whitechain RPC mock for the v2 pages: digest views compute the real EIP-712 digests from their arguments. */
export async function mockV2(page: Page, s: V2State) {
  const json = (id: number, result: unknown) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  await page.route(WC_RPC, async (route) => {
    const { id, params } = route.request().postDataJSON();
    const to: string = (params?.[0]?.to ?? '').toLowerCase();
    const data: Hex = params?.[0]?.data ?? '0x';
    if (data.startsWith(SEL.webAuthnVerifier)) return route.fulfill(json(id, word('address', VERIFIER)));
    if (data.startsWith(SEL.predictAddress)) return route.fulfill(json(id, word('address', APPROVER_ACCOUNT)));
    if (to === PM2.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: paymentModuleV2Abi, data });
      const r = (result: unknown) => route.fulfill(json(id, encodeFunctionResult({ abi: paymentModuleV2Abi, functionName, result } as never)));
      if (functionName === 'configV2Of') {
        // No config in this test: answer like an unconfigured account (a revert), instead of encoding undefined.
        if (!s.config) return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } }) });
        return r(s.config);
      }
      if (functionName === 'windowAvailable') return r(s.window ?? [0n, 0n]);
      if (functionName === 'pendingExit') return r(s.pendingExit ?? ['0x0000000000000000000000000000000000000000', 0n]);
      if (functionName === 'payeeAddedAt') return r(s.payeeAddedAt ?? 0n);
      if (functionName === 'invoiceDigest') return r(invoiceAuthDigestV2(args![0] as never, { chainId: 1874, verifyingContract: PM2 }));
      if (functionName === 'typedDigest') {
        const sep = domainSeparator({ domain: { name: 'Tazor', version: '2', chainId: 1874, verifyingContract: PM2 } });
        return r(keccak256(concat(['0x1901', sep, args![0] as Hex])));
      }
    }
    if (to === MM2.toLowerCase()) {
      // MandateModuleV2: the real v2 EIP-712 digest (domain version "2"); no mandates stored
      const { functionName, args } = decodeFunctionData({ abi: mandateModuleAbi, data });
      s.mm2Calls?.push(functionName);
      const r = (result: unknown) => route.fulfill(json(id, encodeFunctionResult({ abi: mandateModuleAbi, functionName, result } as never)));
      if (functionName === 'mandateDigest') return r(mandateDigest(args![0] as never, MM2, 1874, '2'));
    }
    if (to === FM.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: financingModuleAbi, data });
      const r = (result: unknown) => route.fulfill(json(id, encodeFunctionResult({ abi: financingModuleAbi, functionName, result } as never)));
      if (functionName === 'financedDigest') return r(financedDigest(args![0] as never, { chainId: 1874, verifyingContract: FM }));
      if (functionName === 'claims') return r(s.claim ?? ['0x0000000000000000000000000000000000000000', 0n, 0n]);
      if (functionName === 'listings') return r(s.listing ?? 0n);
      if (functionName === 'ownerOf') return r(s.owner);
    }
    return route.fulfill(json(id, '0x'));
  });
  await page.route('http://relayer.test/**', (route) => route.abort('connectionrefused'));
}

export async function onboard(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto('/onboard/');
  await page.getByTestId('create').click();
}
