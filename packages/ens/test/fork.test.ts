import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createPublicClient, createTestClient, createWalletClient, http, parseEther, BaseError, ContractFunctionRevertedError,
  type Address, type PublicClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import {
  addApprover, addMember, createCompany, getRoles, removeApprover, rootRolesSlot, userRegistryAbi,
  COMPANY_ADMIN_ROLES, ROLE_APPROVER, ROLE_UPGRADE, ROLES_MAPPING_SLOT, SEPOLIA, type Clients, type Receipt,
} from '../src/index.ts';

const FORK_URL = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const TAZ0R_OWNER: Address = '0xce4389ACb79463062c362fACB8CB04513fA3D8D8';
const COMPANY_ADMIN: Address = '0x00000000000000000000000000000000000a11ce';
const APPROVER: Address = '0x0000000000000000000000000000000000000b0b';
const OUTSIDER: Address = '0x000000000000000000000000000000000000bad0';
const MEMBER: Address = '0x000000000000000000000000000000000000f00d';
const LABEL = 'acme-fork-test';

let anvil: ChildProcess;
let pub: PublicClient;
const clients = (account: Address): Clients => ({
  public: pub,
  wallet: createWalletClient({ chain: sepolia, transport: http(RPC), account }),
});
const gas: Record<string, bigint> = {};
const record = (name: string, r: Receipt) => { gas[name] = r.gasUsed; };
let company: Address;

before(async () => {
  const head = await createPublicClient({ chain: sepolia, transport: http(FORK_URL) }).getBlockNumber();
  const forkBlock = head - 5n;
  anvil = spawn('anvil', ['--fork-url', FORK_URL, '--fork-block-number', String(forkBlock), '--port', String(PORT), '--silent'], { stdio: 'inherit' });
  pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break; } catch { if (i > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); }
  }
  console.log(`anvil fork of Sepolia at block ${forkBlock}`);
  const testClient = createTestClient({ chain: sepolia, mode: 'anvil', transport: http(RPC) });
  for (const a of [TAZ0R_OWNER, COMPANY_ADMIN, OUTSIDER]) {
    await testClient.impersonateAccount({ address: a });
    await testClient.setBalance({ address: a, value: parseEther('10') });
  }
});

after(() => {
  console.log('gas used:', Object.entries(gas).map(([k, v]) => `${k}=${v}`).join(' '));
  anvil?.kill();
});

test('createCompany end to end', async () => {
  const { registry, gas: g } = await createCompany(clients(TAZ0R_OWNER), clients(COMPANY_ADMIN), LABEL);
  company = registry;
  record('deployProxy', g.deploy); record('register(company)', g.register); record('setParent', g.setParent);
  const read = (functionName: string, args: readonly unknown[], address: Address = SEPOLIA.parentRegistry) =>
    pub.readContract({ address, abi: userRegistryAbi, functionName, args } as never) as Promise<unknown>;
  assert.equal(String(await read('findOwner', [LABEL])).toLowerCase(), COMPANY_ADMIN);
  assert.equal(await read('getSubregistry', [LABEL]), registry);
  assert.equal(await read('getResolver', [LABEL]), SEPOLIA.resolver);
  assert.deepEqual(await read('getParent', [], registry), [SEPOLIA.parentRegistry, LABEL]);
  assert.equal(await getRoles({ public: pub }, registry, COMPANY_ADMIN), COMPANY_ADMIN_ROLES);
  console.log(`company registry ${registry}`);
});

test('company admin cannot relink, unregister or upgrade', async () => {
  const tokenId = await pub.readContract({ address: SEPOLIA.parentRegistry, abi: userRegistryAbi, functionName: 'findTokenId', args: [LABEL] });
  for (const [functionName, args] of [['setSubregistry', [tokenId, OUTSIDER]], ['unregister', [tokenId]]] as const) {
    await assert.rejects(pub.simulateContract({
      address: SEPOLIA.parentRegistry, abi: userRegistryAbi, functionName, args, account: COMPANY_ADMIN,
    } as never));
  }
  assert.equal((await getRoles({ public: pub }, company, COMPANY_ADMIN)) & ROLE_UPGRADE, 0n);
});

test('add then remove approver', async () => {
  record('grantRootRoles(APPROVER)', await addApprover(clients(COMPANY_ADMIN), company, APPROVER));
  assert.equal(await getRoles({ public: pub }, company, APPROVER), ROLE_APPROVER);
  record('revokeRootRoles(APPROVER)', await removeApprover(clients(COMPANY_ADMIN), company, APPROVER));
  assert.equal(await getRoles({ public: pub }, company, APPROVER), 0n);
});

test('non-admin grant reverts', async () => {
  await assert.rejects(addApprover(clients(OUTSIDER), company, OUTSIDER), (e: unknown) => {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    assert.ok(revert instanceof ContractFunctionRevertedError);
    assert.equal(revert.data?.errorName, 'EACCannotGrantRoles');
    return true;
  });
  assert.equal(await getRoles({ public: pub }, company, OUTSIDER), 0n);
});

test('addMember then findOwner', async () => {
  record('register(member)', await addMember(clients(COMPANY_ADMIN), company, 'priya', MEMBER, SEPOLIA.maxExpiry));
  const owner = await pub.readContract({ address: company, abi: userRegistryAbi, functionName: 'findOwner', args: ['priya'] });
  assert.equal(owner.toLowerCase(), MEMBER);
});

test('roles storage slot formula', async () => {
  await addApprover(clients(COMPANY_ADMIN), company, APPROVER);
  for (const account of [APPROVER, COMPANY_ADMIN]) {
    const expected = await getRoles({ public: pub }, company, account);
    let found: bigint | undefined;
    for (let base = 0n; base < 256n && found === undefined; base++) {
      const v = await pub.getStorageAt({ address: company, slot: rootRolesSlot(account, base) });
      if (v && BigInt(v) === expected) found = base;
    }
    console.log(`${account}: roles(0)=0x${expected.toString(16)} found at BASE=${found}`);
    assert.equal(found, ROLES_MAPPING_SLOT);
    const direct = await pub.getStorageAt({ address: company, slot: rootRolesSlot(account) });
    assert.equal(BigInt(direct!), expected);
  }
});
