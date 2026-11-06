import { parseAbi } from 'viem';

export const verifiableFactoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function predictProxyAddress(address deployer, uint256 salt) view returns (address)',
]);

export const userRegistryAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function setParent(address parent, string label)',
  'function getParent() view returns (address, string)',
  'function findOwner(string label) view returns (address)',
  'function findTokenId(string label) view returns (uint256)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function findExpiry(string label) view returns (uint64)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function unregister(uint256 anyId)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACMaxAssignees(uint256 resource, uint256 role)',
  'error LabelAlreadyRegistered(string label)',
  'error CannotSetPastExpiry(uint64 expiry)',
  'error InvalidOwner()',
]);
