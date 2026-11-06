import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { createSender } from './sender.ts';
import { createMirror } from './mirror.ts';

const wcRpc = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const l1Rpc = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const whitechain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [wcRpc] } } });
const key = process.env.ENS_ADMIN_PRIVATE_KEY as Hex | undefined;
const pairs = (process.env.REVOCATION_LISTS ?? '0x407a8605Fc6fe002Eb025b2dcf9f9C630d5D311e:0xe19ddf1fd417B146137A5dE6eb56c4589431540A')
  .split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const [list, pm] = p.split(':'); return { list: getAddress(list), paymentModule: getAddress(pm) }; });
if (!key) {
  console.error('ENS_ADMIN_PRIVATE_KEY (a company ENS admin on Sepolia) is required');
  process.exit(1);
}
const l1Sender = createSender({ rpcUrl: l1Rpc, chain: sepolia, privateKey: key });
createMirror({
  l2: createPublicClient({ chain: whitechain, transport: http(wcRpc) }),
  l1: createPublicClient({ chain: sepolia, transport: http(l1Rpc) }),
  revocationLists: pairs,
  send: (to, data) => l1Sender.send(to, data),
  lookback: BigInt(process.env.LOOKBACK_BLOCKS ?? 200),
}).start(Number(process.env.POLL_MS ?? 12_000));
