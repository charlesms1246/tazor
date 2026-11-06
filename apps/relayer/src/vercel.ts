import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlerFromEnv } from './env.ts';
import { proveRoles } from '../../../packages/prover/scripts/prove-roles.ts';

// Proofs are built in-process (about 2.3 s each), bundled by esbuild from packages/prover.
const { handler } = handlerFromEnv(process.env, {
  // Reports the proof's own L1 block (the commit index) so a sync never writes roles older than ENS's latest change.
  prover: async (registry, account) => {
    let l1Block: bigint | undefined;
    const proof = await proveRoles(registry, account, {
      sepoliaRpc: process.env.SEPOLIA_PROOF_RPC || process.env.SEPOLIA_RPC || undefined,
      whitechainRpc: process.env.WC_RPC || undefined,
      onInfo: (i) => { l1Block = i.l1Block; },
    });
    return { proof, l1Block };
  },
});

/** Vercel Node function: every path is rewritten here and served by the same handler as the container. */
export default function relayer(req: IncomingMessage, res: ServerResponse) {
  const original = req.headers['x-original-path'];
  if (typeof original === 'string' && original) req.url = original;
  return handler(req, res);
}
