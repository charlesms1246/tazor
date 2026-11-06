import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlerFromEnv } from './env.ts';

const { handler } = handlerFromEnv();

/** Vercel Node function: every path is rewritten here and served by the same handler as the container. */
export default function relayer(req: IncomingMessage, res: ServerResponse) {
  const original = req.headers['x-original-path'];
  if (typeof original === 'string' && original) req.url = original;
  return handler(req, res);
}
