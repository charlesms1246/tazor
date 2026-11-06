import {
  encodeAbiParameters, encodeFunctionData, keccak256, stringToHex,
  type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { userRegistryAbi, verifiableFactoryAbi } from './abi.ts';
import { COMPANY_ADMIN_ROLES, COMPANY_NAME_ROLES, NAME_OWNER_ROLES, ROLE_AGENT, ROLE_APPROVER } from './roles.ts';

export const SEPOLIA = {
  parentRegistry: '0x44007108C0Cca53498F19F259E73E70C2ebE900a',
  verifiableFactory: '0xda70306c98e97ece36f997a21368e53298572991',
  userRegistryImpl: '0x9bd8a88719068d09ecee662f36c0e3856708366a',
  resolver: '0x9a268461Cd084FD5F973C465E3E0131Aa02AB673',
  maxExpiry: 1888629000n,
} as const satisfies Record<string, Address | bigint>;

export const ROLES_MAPPING_SLOT = 2n;

type Wallet = WalletClient<Transport, Chain, Account>;
export type Clients = { public: PublicClient; wallet: Wallet };
export type Receipt = { hash: Hex; gasUsed: bigint };

async function send(c: Clients, to: Address, data: Hex): Promise<Receipt> {
  const hash = await c.wallet.sendTransaction({ to, data });
  const r = await c.public.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`tx ${hash} reverted`);
  return { hash, gasUsed: r.gasUsed };
}

async function write(c: Clients, address: Address, functionName: string, args: readonly unknown[]): Promise<Receipt> {
  const req = { address, abi: userRegistryAbi, functionName, args, account: c.wallet.account } as never;
  await c.public.simulateContract(req);
  return send(c, address, encodeFunctionData({ abi: userRegistryAbi, functionName, args } as never));
}

export const companySalt = (label: string) => BigInt(keccak256(stringToHex(`taz0r.eth/company/${label}`)));

export const predictCompanyRegistry = (c: Pick<Clients, 'public'>, deployer: Address, label: string) =>
  c.public.readContract({
    address: SEPOLIA.verifiableFactory, abi: verifiableFactoryAbi, functionName: 'predictProxyAddress',
    args: [deployer, companySalt(label)],
  });

export async function createCompany(
  registrar: Clients,
  admin: Clients,
  label: string,
  expiry: bigint = SEPOLIA.maxExpiry,
) {
  const adminAddress = admin.wallet.account.address;
  const registry = await predictCompanyRegistry(registrar, registrar.wallet.account.address, label);
  const init = encodeFunctionData({
    abi: userRegistryAbi, functionName: 'initialize', args: [[{ account: adminAddress, roleBitmap: COMPANY_ADMIN_ROLES }]],
  });
  const deploy = await send(registrar, SEPOLIA.verifiableFactory, encodeFunctionData({
    abi: verifiableFactoryAbi, functionName: 'deployProxy', args: [SEPOLIA.userRegistryImpl, companySalt(label), init],
  }));
  const register = await write(registrar, SEPOLIA.parentRegistry, 'register',
    [label, adminAddress, registry, SEPOLIA.resolver, COMPANY_NAME_ROLES, expiry]);
  const setParent = await write(admin, registry, 'setParent', [SEPOLIA.parentRegistry, label]);
  return { registry, gas: { deploy, register, setParent } };
}

export const addApprover = (admin: Clients, company: Address, account: Address) =>
  write(admin, company, 'grantRootRoles', [ROLE_APPROVER, account]);
export const removeApprover = (admin: Clients, company: Address, account: Address) =>
  write(admin, company, 'revokeRootRoles', [ROLE_APPROVER, account]);
export const addAgent = (admin: Clients, company: Address, account: Address) =>
  write(admin, company, 'grantRootRoles', [ROLE_AGENT, account]);
export const removeAgent = (admin: Clients, company: Address, account: Address) =>
  write(admin, company, 'revokeRootRoles', [ROLE_AGENT, account]);

export const getRoles = (c: Pick<Clients, 'public'>, company: Address, account: Address) =>
  c.public.readContract({ address: company, abi: userRegistryAbi, functionName: 'roles', args: [0n, account] });

export const addMember = (admin: Clients, company: Address, label: string, owner: Address, expiry: bigint) =>
  write(admin, company, 'register', [label, owner, '0x0000000000000000000000000000000000000000', SEPOLIA.resolver, NAME_OWNER_ROLES, expiry]);

export function rootRolesSlot(account: Address, base: bigint = ROLES_MAPPING_SLOT): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, base]));
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [account, inner]));
}
