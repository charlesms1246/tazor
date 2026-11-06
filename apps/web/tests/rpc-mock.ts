import type { Page } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from 'viem';

type Handler = { abi: Abi; fn: string; result: (args: readonly unknown[]) => unknown };
const json = (id: number, result: unknown) => ({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });

/** Routes eth_call by (to, function name) to typed results; eth_getCode by address; everything else -> null / 0x. */
export async function routeRpc(page: Page, url: string, calls: Record<string, Handler[]>, code: Record<string, Hex> = {}) {
  await page.route(url, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    if (method === 'eth_getCode') return route.fulfill(json(id, code[(params[0] as string).toLowerCase()] ?? '0x'));
    if (method !== 'eth_call') return route.fulfill(json(id, null));
    const to = (params[0].to as string).toLowerCase();
    const data = params[0].data as Hex;
    for (const h of calls[to] ?? []) {
      try {
        const d = decodeFunctionData({ abi: h.abi, data });
        if (d.functionName !== h.fn) continue;
        return route.fulfill(json(id, encodeFunctionResult({ abi: h.abi, functionName: h.fn, result: h.result(d.args ?? []) } as never)));
      } catch { /* other function */ }
    }
    return route.fulfill(json(id, '0x'));
  });
}

export const lc = (a: Address) => a.toLowerCase();
