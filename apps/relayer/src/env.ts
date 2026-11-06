import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { createHandler } from './app.ts';
import { createApproverDeployer } from './approver.ts';
import { createSender } from './sender.ts';
import { sepolia } from 'viem/chains';
import { createRoleSync, type Prover } from './sync.ts';
import { createMirrorService } from './mirror-service.ts';
import { REVOCATION_LIST_V2 } from './revoke-list.ts';
import { PAYMENT_MODULE_V2 } from './payrun.ts';
import { MANDATE_MODULE_V2 } from './mandate.ts';
import { sandboxFromEnv } from './sandbox/config.ts';
import { createSandboxPorts } from './sandbox/ports.ts';
import { createSandbox } from './sandbox/service.ts';
import { createGuard, limitsFromEnv } from './guard.ts';

export const DEFAULT_SEPOLIA_RPC = 'https://sepolia.gateway.tenderly.co';
export const DEFAULT_ROLE_CACHE = '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe';

/** Comma-separated ENS registries the relayer may sync (it pays the gas). */
export const watchRegistries = (env: Record<string, string | undefined>) =>
  (env.WATCH_REGISTRIES ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a));

/**
 * Builds the relayer's request handler from environment variables.
 * Role syncing (POST /sync, GET /watch) is on when a prover is passed and RELAYER_PRIVATE_KEY is set;
 * only WATCH_REGISTRIES are synced. The prover is passed in so the Docker image never loads the prover code.
 */
export function handlerFromEnv(env: Record<string, string | undefined> = process.env, opts: { prover?: Prover } = {}) {
  const rpcUrl = env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
  const whitechainSepolia = defineChain({
    id: Number(env.CHAIN_ID ?? 1874),
    name: 'Whitechain Sepolia',
    nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const paymentModule = getAddress(env.PAYMENT_MODULE || '0xe19ddf1fd417B146137A5dE6eb56c4589431540A');
  const approverFactory = getAddress(env.APPROVER_ACCOUNT_FACTORY || '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e');
  const revocationList = getAddress(env.REVOCATION_LIST || '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e');
  const mandateModule = getAddress(env.MANDATE_MODULE || '0xB6f4F1B437AC30223D3661bD7bdd12aAec73aC32');
  const raw = env.RELAYER_PRIVATE_KEY?.trim();
  const key = (raw ? (raw.startsWith('0x') ? raw : `0x${raw}`) : undefined) as Hex | undefined;
  const sender = key ? createSender({ rpcUrl, chain: whitechainSepolia, privateKey: key }) : undefined;
  const client = createPublicClient({ chain: whitechainSepolia, transport: http(rpcUrl) });
  const approvers = createApproverDeployer(client, approverFactory);

  const paymaster = env.PAYMASTER ? getAddress(env.PAYMASTER) : undefined;
  const sepoliaRpc = env.SEPOLIA_RPC || DEFAULT_SEPOLIA_RPC;
  const roleSync = opts.prover && sender
    ? createRoleSync({
      l1: createPublicClient({ chain: sepolia, transport: http(sepoliaRpc) }) as never,
      l2: client as never,
      roleCache: getAddress(env.ROLE_CACHE || DEFAULT_ROLE_CACHE),
      registries: watchRegistries(env),
      send: (to, data) => sender.send(to, data),
      prove: opts.prover,
    })
    : undefined;
  const cronSecret = env.CRON_SECRET || undefined;
  // Mirroring sends on Sepolia with the same key, and only where that address is already an APPROVER admin.
  const l1Sender = key ? createSender({ rpcUrl: sepoliaRpc, chain: sepolia, privateKey: key }) : undefined;
  const mirror = env.MIRROR === '0' ? undefined : createMirrorService({
    l1: createPublicClient({ chain: sepolia, transport: http(sepoliaRpc) }) as never,
    l2: client as never,
    lists: [
      { list: revocationList, paymentModule },
      { list: getAddress(env.REVOCATION_LIST_V2 || REVOCATION_LIST_V2), paymentModule: getAddress(env.PAYMENT_MODULE_V2 || PAYMENT_MODULE_V2) },
    ],
    registries: watchRegistries(env),
    sender: l1Sender,
    lookback: env.MIRROR_LOOKBACK ? BigInt(env.MIRROR_LOOKBACK) : undefined,
  });
  // Autopilot sandbox: on only when every SANDBOX_* address and key is set.
  const sandboxEnv = sandboxFromEnv(env);
  const sandbox = sandboxEnv.config
    ? createSandbox({
      config: sandboxEnv.config,
      ports: createSandboxPorts({ config: sandboxEnv.config, whitechain: whitechainSepolia, wcRpc: rpcUrl, sepoliaRpc, relayer: sender, roleSync }),
    })
    : undefined;
  // drain protection: rate limits plus a balance floor and daily budget read from the relayer's own WBT balance
  const guard = sender ? createGuard({
    limits: limitsFromEnv(env),
    balance: () => client.getBalance({ address: sender.address }),
    gasPrice: () => client.getGasPrice(),
  }) : undefined;
  const handler = createHandler({
    sender, paymentModule, approvers, revocationList, mandateModule, client: client as never, paymaster, chainId: whitechainSepolia.id,
    mandateModuleV2: getAddress(env.MANDATE_MODULE_V2 || MANDATE_MODULE_V2), paymentModuleV2: getAddress(env.PAYMENT_MODULE_V2 || PAYMENT_MODULE_V2),
    roleSync, cronSecret, mirror, sandbox, guard,
  });
  return { handler, sender, paymentModule, approverFactory, revocationList, mandateModule, paymaster, chainId: whitechainSepolia.id, roleSync, sepoliaRpc, mirror, sandbox, guard };
}
