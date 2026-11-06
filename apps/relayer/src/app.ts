import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequest, encodePayOne, parsePayRequest } from './payment.ts';
import { SimulationFailed, type Sender } from './sender.ts';
import { parseSigner, type ApproverDeployer } from './approver.ts';
import { encodeRevoke, parseRevokeRequest } from './revoke.ts';
import { encodeCreateMandate, encodePull, parseMandateRequest, parsePullRequest } from './mandate.ts';
import type { PublicClient } from 'viem';
import { PAYMENT_MODULE_V2, parsePayRunRequest, preparePayRun } from './payrun.ts';
import { preparePayOne } from './pay-counterfactual.ts';
import { REVOCATION_LIST_V2, pickRevocationList } from './revoke-list.ts';
import { ENTRY_POINT_V08, RpcError, encodeHandleOps, parseUserOp, paymasterRpc } from './userop.ts';

const MAX_BODY = 64 * 1024;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BadRequest('body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BadRequest('invalid JSON'); }
}

export function createHandler(deps: {
  sender?: Sender; paymentModule?: `0x${string}`; approvers?: ApproverDeployer; revocationList?: `0x${string}`;
  mandateModule?: `0x${string}`; client?: PublicClient; paymentModuleV2?: `0x${string}`; revocationListV2?: `0x${string}`;
  paymaster?: `0x${string}`; chainId?: number;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(body));
      console.log(`${req.method} ${req.url} ${status}`);
    };
    try {
      if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
      if (req.method === 'GET' && req.url === '/health') {
        return reply(200, {
          ok: true, relayer: deps.sender?.address ?? null, paymentModule: deps.paymentModule ?? null,
          approverAccountFactory: deps.approvers?.factory ?? null, revocationList: deps.revocationList ?? null,
          mandateModule: deps.mandateModule ?? null,
        });
      }
      if (req.method === 'POST' && (req.url === '/mandate' || req.url === '/pull')) {
        const json = await readJson(req);
        const data = req.url === '/mandate' ? encodeCreateMandate(parseMandateRequest(json)) : encodePull(parsePullRequest(json));
        if (!deps.sender || !deps.mandateModule) return reply(503, { error: 'relayer not configured', to: deps.mandateModule ?? null, data });
        return reply(200, { txHash: await deps.sender.send(deps.mandateModule, data) });
      }
      if (req.method === 'POST' && req.url === '/revoke') {
        const json = await readJson(req);
        const data = encodeRevoke(parseRevokeRequest(json));
        const list = pickRevocationList(json, deps.revocationList, deps.revocationListV2 ?? REVOCATION_LIST_V2);
        if (!deps.sender || !list) return reply(503, { error: 'relayer not configured', to: list ?? null, data });
        return reply(200, { txHash: await deps.sender.send(list, data) });
      }
      if (req.method === 'POST' && req.url === '/approver') {
        const a = deps.approvers;
        if (!a) return reply(503, { error: 'approver factory not configured' });
        const signer = parseSigner(await readJson(req), await a.webAuthnVerifier());
        const account = await a.predict(signer);
        if (await a.isDeployed(account)) return reply(200, { account, txHash: null });
        if (!deps.sender) return reply(503, { error: 'relayer not configured', account });
        return reply(200, { account, txHash: await deps.sender.send(a.factory, a.createCalldata(signer)) });
      }
      if (req.method === 'POST' && (req.url === '/pay' || req.url === '/pay/calldata')) {
        const parsed = parsePayRequest(await readJson(req));
        const data = encodePayOne(parsed);
        if (req.url === '/pay/calldata') return reply(200, { to: deps.paymentModule ?? null, data });
        if (!deps.sender || !deps.paymentModule) return reply(503, { error: 'relayer not configured; submit /pay/calldata yourself' });
        if (!deps.client || !deps.approvers) return reply(200, { txHash: await deps.sender.send(deps.paymentModule, data) });
        const p = await preparePayOne(deps.client, deps.approvers.factory, deps.paymentModule, parsed);
        const deployTxs = [];
        for (const d of p.deploys) deployTxs.push(await deps.sender.send(d.to, d.data));
        return reply(200, { txHash: await deps.sender.send(deps.paymentModule, p.data), deployTxs });
      }
      if (req.method === 'POST' && req.url === '/payrun') {
        const parsed = parsePayRunRequest(await readJson(req));
        if (!deps.sender || !deps.paymentModule || !deps.client || !deps.approvers) return reply(503, { error: 'relayer not configured; use Copy calldata' });
        const p = await preparePayRun(deps.client, deps.approvers.factory, deps.paymentModule, deps.paymentModuleV2 ?? PAYMENT_MODULE_V2, parsed);
        const deployTxs = [];
        for (const d of p.deploys) deployTxs.push(await deps.sender.send(d.to, d.data));
        return reply(200, { txHash: await deps.sender.send(p.to, p.data), paymentModule: p.to, deployTxs });
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        const body = (await readJson(req)) as { id?: unknown; method?: unknown; params?: unknown } | null;
        const id = body?.id ?? null;
        try {
          const result = await paymasterRpc(String(body?.method), body?.params, { paymaster: deps.paymaster, chainId: deps.chainId ?? 1874, client: deps.client });
          return reply(200, { jsonrpc: '2.0', id, result });
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          return reply(200, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
        }
      }
      if (req.method === 'POST' && req.url === '/userop') {
        const body = (await readJson(req)) as { userOp?: unknown } | null;
        const op = parseUserOp(body?.userOp, { requireSignature: true });
        if (!deps.sender) return reply(503, { error: 'relayer not configured' });
        return reply(200, { txHash: await deps.sender.send(ENTRY_POINT_V08, encodeHandleOps(op, deps.sender.address)) });
      }
      return reply(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BadRequest) return reply(400, { error: e.message });
      if (e instanceof SimulationFailed) return reply(422, { error: `simulation reverted: ${e.message}` });
      return reply(502, { error: 'upstream error' });
    }
  };
}
