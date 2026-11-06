import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequest, encodePayOne, parsePayRequest } from './payment.ts';
import { SimulationFailed, type Sender } from './sender.ts';

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

export function createHandler(deps: { sender?: Sender; paymentModule?: string }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(body));
      console.log(`${req.method} ${req.url} ${status}`);
    };
    try {
      if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
      if (req.method === 'GET' && req.url === '/health') {
        return reply(200, { ok: true, relayer: deps.sender?.address ?? null, paymentModule: deps.paymentModule ?? null });
      }
      if (req.method === 'POST' && (req.url === '/pay' || req.url === '/pay/calldata')) {
        const data = encodePayOne(parsePayRequest(await readJson(req)));
        if (req.url === '/pay/calldata') return reply(200, { to: deps.paymentModule ?? null, data });
        if (!deps.sender) return reply(503, { error: 'relayer not configured; submit /pay/calldata yourself' });
        return reply(200, { txHash: await deps.sender.send(data) });
      }
      return reply(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BadRequest) return reply(400, { error: e.message });
      if (e instanceof SimulationFailed) return reply(422, { error: `simulation reverted: ${e.message}` });
      return reply(502, { error: 'upstream error' });
    }
  };
}
