import type { IncomingMessage } from 'node:http';
import { BadRequest } from '../payment.ts';
import { SimulationFailed } from '../sender.ts';
import { RateLimited, SandboxRefused, errorText, type Sandbox } from './service.ts';

/** The caller's IP: the first X-Forwarded-For hop (set by Vercel and most proxies), else the socket address. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

/**
 * /sandbox/* routes. Returns false for other paths. Errors come back in the action shape
 * ({ok: false, status: 'failed' | 'refused' (403), error, reason, detail, tx: null, chain, explorerUrl: null}) with 400, 403, 422, 429 or 502.
 */
export async function handleSandbox(
  req: IncomingMessage, path: string, sandbox: Sandbox, readJson: (req: IncomingMessage) => Promise<unknown>,
  reply: (status: number, body: unknown, headers?: Record<string, string>) => void,
): Promise<boolean> {
  const route = `${req.method} ${path}`;
  if (!['POST /sandbox/admit', 'POST /sandbox/counterparty', 'GET /sandbox/status'].includes(route)) return false;
  const failed = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    reply(status, { ok: false, status: status === 403 ? 'refused' : 'failed', error, reason: error, detail: error, tx: null, chain: 'whitechain', explorerUrl: null, ...extra }, headers);
  try {
    if (route === 'GET /sandbox/status') reply(200, await sandbox.status());
    else if (route === 'POST /sandbox/admit') reply(200, await sandbox.admit(await readJson(req), clientIp(req)));
    else reply(200, await sandbox.counterparty(await readJson(req)));
  } catch (e) {
    if (e instanceof BadRequest) failed(400, e.message);
    else if (e instanceof SandboxRefused) failed(403, e.message);
    else if (e instanceof RateLimited) failed(429, e.message, { retryAfterSec: e.retryAfterSec }, { 'retry-after': String(e.retryAfterSec) });
    else if (e instanceof SimulationFailed) failed(422, `simulation reverted: ${e.message}`);
    else { const why = errorText(e); console.error('sandbox', route, why); failed(502, `upstream error: ${why}`); }
  }
  return true;
}
