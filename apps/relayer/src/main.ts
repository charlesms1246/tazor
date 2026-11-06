import { createServer } from 'node:http';
import { handlerFromEnv, watchRegistries } from './env.ts';
import { commandProver } from './watcher.ts';

// The Docker image only has apps/relayer/src, so role proofs come from an external command (PROVER_CMD), never an import.
const prover = watchRegistries(process.env).length
  ? commandProver(process.env.PROVER_CMD || 'bun ../../packages/prover/scripts/sync-roles.ts')
  : undefined;
const r = handlerFromEnv(process.env, { prover });
const port = Number(process.env.PORT ?? 8787);
createServer(r.handler).listen(port, '0.0.0.0', () => {
  console.log(`relayer on :${port} chain ${r.chainId} sender=${r.sender?.address ?? 'none'} paymentModule=${r.paymentModule} approverFactory=${r.approverFactory} revocationList=${r.revocationList} mandateModule=${r.mandateModule} paymaster=${r.paymaster ?? 'unset'} roleSync=${r.roleSync ? r.roleSync.registries.join(',') : 'off'}`);
});
