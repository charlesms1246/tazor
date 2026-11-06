import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { createSender } from './sender.ts';
import { commandProver, createWatcher } from './watcher.ts';

const wcRpc = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const whitechainSepolia = defineChain({
  id: Number(process.env.CHAIN_ID ?? 1874),
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [wcRpc] } },
});
const l1Rpc = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const registries = (process.env.WATCH_REGISTRIES ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a));
const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
if (registries.length === 0 || !key) {
  console.error('WATCH_REGISTRIES and RELAYER_PRIVATE_KEY are required');
  process.exit(1);
}

const sender = createSender({ rpcUrl: wcRpc, chain: whitechainSepolia, privateKey: key });
createWatcher({
  l1: createPublicClient({ chain: sepolia, transport: http(l1Rpc) }),
  l2: createPublicClient({ chain: whitechainSepolia, transport: http(wcRpc) }),
  registries,
  roleCache: getAddress(process.env.ROLE_CACHE || '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe'),
  send: (to, data) => sender.send(to, data),
  prove: commandProver(process.env.PROVER_CMD || 'bun ../../packages/prover/scripts/sync-roles.ts'),
}).start(Number(process.env.POLL_MS ?? 12_000));
