// Live check (read-only, Ethereum Sepolia + Whitechain Sepolia): the storage slot RoleCache proves is really where the
// acme.taz0r.eth registry keeps root roles. If ENSv2 ever moved its EAC mapping, every proof would read zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, defineChain, hexToBigInt, http, parseAbi, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { ROLES_MAPPING_SLOT, ROLE_APPROVER, rootRolesSlot } from '../src/index.ts';

const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const WC_RPC = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';
const ACME_REGISTRY: Address = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1';
const ROLE_CACHE: Address = '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe';
/** Approvers of acme.taz0r.eth (Priya, CFO): they hold APPROVER on the live registry. */
const APPROVERS: Address[] = ['0x00aBed5bDddf794c415eE746d3E4De5332cC5450', '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967'];

test('ROLES_BASE_SLOT = 2: RoleCache\'s constant, the TS helper, and the live acme registry storage all agree', async () => {
  const l1 = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
  const wc = createPublicClient({ chain: defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [WC_RPC] } } }), transport: http(WC_RPC) });

  const onChainBase = await wc.readContract({ address: ROLE_CACHE, abi: parseAbi(['function ROLES_BASE_SLOT() view returns (uint256)']), functionName: 'ROLES_BASE_SLOT' });
  assert.equal(onChainBase, 2n, 'RoleCache on Whitechain');
  assert.equal(ROLES_MAPPING_SLOT, 2n, 'packages/ens');

  const block = await l1.getBlockNumber();
  for (const account of APPROVERS) {
    const viaCall = await l1.readContract({ address: ACME_REGISTRY, abi: parseAbi(['function roles(uint256 resource, address account) view returns (uint256)']), functionName: 'roles', args: [0n, account], blockNumber: block });
    const raw = await l1.getStorageAt({ address: ACME_REGISTRY, slot: rootRolesSlot(account, 2n), blockNumber: block });
    assert.equal(hexToBigInt(raw ?? '0x0'), viaCall, `slot keccak(account, keccak(0, 2)) holds roles(0, ${account})`);
    assert.ok((viaCall & ROLE_APPROVER) !== 0n, `${account} is an APPROVER on acme (otherwise the check proves nothing)`);
    // a wrong base slot reads zero for the same account
    assert.equal(hexToBigInt((await l1.getStorageAt({ address: ACME_REGISTRY, slot: rootRolesSlot(account, 3n), blockNumber: block })) ?? '0x0'), 0n);
  }
});
