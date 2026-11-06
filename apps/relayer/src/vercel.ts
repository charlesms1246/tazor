import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlerFromEnv } from './env.ts';
import { proveRoles } from '../../../packages/prover/scripts/prove-roles.ts';

// Proofs are built in-process (about 2.3 s each), bundled by esbuild from packages/prover.
const { handler } = handlerFromEnv(process.env, {
  prover: (registry, account) => proveRoles(registry, account, {
    sepoliaRpc: process.env.SEPOLIA_PROOF_RPC || process.env.SEPOLIA_RPC || undefined,
    whitechainRpc: process.env.WC_RPC || undefined,
  }),
});

/** Vercel Node function: every path is rewritten here and served by the same handler as the container. */
export default function relayer(req: IncomingMessage, res: ServerResponse) {
  const original = req.headers['x-original-path'];
  if (typeof original === 'string' && original) req.url = original;
  return handler(req, res);
}
