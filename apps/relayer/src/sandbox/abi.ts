import { parseAbi } from 'viem';

/** MirrorOperator (contracts/src/mocks/MirrorOperator.sol): operator keys may only register and verify NEW souls (simulated WB Soul). */
export const mirrorOperatorAbi = parseAbi([
  'function registerVerified(address addr) returns (uint256 soulId)',
  'function remainingToday() view returns (uint256)',
  'function isOperator(address operator) view returns (bool)',
]);

export const soulMirrorAbi = parseAbi([
  'function soulOf(address addr) view returns (uint256)',
  'function soulAttributeValue(uint256 soulId, address attribute) view returns (bytes20)',
  'function isAddressUsed(address addr) view returns (bool)',
]);

export const ensRegistryAbi = parseAbi([
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
]);

export const factoryAbi = parseAbi([
  'function predictAddress(bytes[] signers) view returns (address)',
  'function createAccount(bytes[] signers) returns (address)',
  'function webAuthnVerifier() view returns (address)',
]);

export const roleCacheAbi = parseAbi(['function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)']);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const paymentV2Abi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'struct ConfigV2 { address registry; uint96 twoApproverThreshold; uint96 perPaymentLimit; uint96 monthlyLimit; uint32 payeeDelay; uint96 freshThreshold; uint32 maxCacheAge; uint96 agentMonthlyCap; address[] exitAccounts; uint32 exitDelay; }',
  'function invoiceDigest(InvoiceAuth auth) view returns (bytes32)',
  'function runDigest(InvoiceAuth[] auths) view returns (bytes32)',
  'function payOne(address account, InvoiceAuth auth, address[] approvers, bytes[] signatures)',
  'function registryOf(address account) view returns (address)',
  'function configV2Of(address account) view returns (ConfigV2)',
  'function windowAvailable(address account) view returns (uint256 company, uint256 agents)',
  'function isPaid(address account, uint256 nonce) view returns (bool)',
]);

export const revocationV2Abi = parseAbi([
  'function isRevoked(address account, address approver) view returns (bool)',
  'function revokeDigest(address account, address target, uint256 deadline) view returns (bytes32)',
  'function revoke(address account, address target, address admin, uint256 deadline, bytes sig)',
]);

export const mandateV2Abi = parseAbi([
  'struct State { address account; uint64 period; bool cancelled; address payee; uint64 start; uint64 cap; uint64 expiry; uint64 spent; uint32 periodIndex; }',
  'function mandateOf(bytes32 mandateId) view returns (State)',
  'function available(bytes32 mandateId) view returns (uint256)',
  'function pull(bytes32 mandateId, uint256 amount)',
]);

export const financingAbi = parseAbi([
  'function claims(uint256 tokenId) view returns (address account, uint64 dueDate, uint256 amount)',
  'function listings(uint256 tokenId) view returns (uint256 price)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function buy(uint256 tokenId)',
  'function settle(uint256 tokenId)',
]);

export const IS_VERIFIED_ATTRIBUTE = '0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41' as const;
export const VERIFIED = '0x0000000000000000000000000000000000000001' as const;
export const ROLE_APPROVER = 1n << 64n;
/** Every sandbox amount is capped at 1 USDT (6 decimals). */
export const MAX_SANDBOX_AMOUNT = 1_000_000n;

export const ADDRESSES = {
  usdt: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7',
  approverFactory: '0xf15c31bCd909e08AAc394D1e2E4dbf6D11223D8e',
  paymentModuleV1: '0xe19ddf1fd417B146137A5dE6eb56c4589431540A',
  paymentModuleV2: '0x906620D82e2959351c81D731C67EA46DF71E36f3',
  revocationListV2: '0x4AD540Fe50Fbb7bD8D8Df66Da3b9a1Bdd39B2f5a',
  mandateModuleV2: '0x24b6eC6f6bf7e58bB3266b0b2701aE451ab7220F',
  financingModule: '0x7BEBCFC47be110a0175452456267bFdaD45DdE8B',
  roleCache: '0x8AC436e5BB681aE4d576e0131391aE3AACA88BDe',
} as const;

export const EXPLORERS = {
  whitechain: 'https://explorer.testnet.whitechain.io',
  sepolia: 'https://sepolia.etherscan.io',
} as const;
