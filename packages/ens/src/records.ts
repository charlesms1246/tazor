import { encodeFunctionData, getAddress, parseAbi, toHex, type Address, type Hex } from 'viem';
import { NAME_OWNER_ROLES } from './roles.ts';
import { SEPOLIA } from './company.ts';

/** ENSIP-11: an EVM chain's coin type is 0x80000000 | chainId; Ethereum mainnet keeps SLIP-44 coin type 60. */
export function coinTypeForChain(chainId: number): bigint {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId >= 0x80000000) throw new Error(`invalid chainId ${chainId}`);
  return chainId === 1 ? 60n : BigInt(0x80000000) | BigInt(chainId);
}
export const ETH_COIN_TYPE = 60n;
export const WHITECHAIN_SEPOLIA_COIN_TYPE = coinTypeForChain(1874);

/** DNS wire format (RFC 1035), as ENSv2's PermissionedResolver expects for `bytes name`. */
export function dnsEncode(name: string): Hex {
  const out: number[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length > 63) throw new Error(`label too long: ${label}`);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return toHex(Uint8Array.from(out));
}

export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
]);
export const memberRegistryAbi = parseAbi([
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function findOwner(string label) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
]);

export type CompanyPlan = {
  label: string;
  texts: Record<string, string>;
  whitechainAccount: Address;
  members: { label: string; address: Address; name: string }[];
};

/** The records Tazor's demo needs on ENS. */
export const DEMO_RECORDS: CompanyPlan[] = [
  {
    label: 'acme',
    texts: { name: 'Acme Industries', description: 'Demo buyer company on Tazor (Whitechain Sepolia)', url: 'https://taz0r.eth.limo', 'tazor.role': 'buyer' },
    whitechainAccount: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
    members: [
      { label: 'priya', address: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', name: 'Priya Sharma, Finance' },
      { label: 'cfo', address: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967', name: 'CFO, Finance' },
      { label: 'ravi', address: '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb', name: 'Ravi, Operations' },
      { label: 'meera', address: '0x03C291d446b870e0B8F128681937a9eCEDa97763', name: 'Meera, contractor' },
    ],
  },
  {
    label: 'bluejay',
    texts: { name: 'Bluejay Logistics', description: 'Demo supplier company on Tazor (Whitechain Sepolia)', url: 'https://taz0r.eth.limo', 'tazor.role': 'supplier' },
    whitechainAccount: '0xc1dce946D192e344251972470237F1471C93876c',
    members: [],
  },
];

/** What a record call should leave on ENS, so a run can skip calls whose value is already in place. */
export type Expect =
  | { kind: 'text'; name: string; key: string; value: string }
  | { kind: 'addr'; name: string; coinType: bigint; address: Address };
export type Call = { to: Address; data: Hex; describe: string; expect?: Expect };

/** True if the current on-chain value already equals the target (case-insensitive for addresses). */
export function alreadySet(e: Expect, current: string | null): boolean {
  if (current === null) return false;
  return e.kind === 'text' ? current === e.value : current.toLowerCase() === e.address.toLowerCase();
}

/** Errors worth retrying: rate limits and the nonce / in-flight rules some RPCs apply to delegated accounts. */
export const isRetryable = (message: string): boolean => /429|too many requests|rate limit|in-flight|inflight|gapped|nonce too (high|low)|replacement transaction underpriced|already known/i.test(message);

/** Resolver calls for one name: text records, then addresses. */
export function recordCalls(name: string, texts: Record<string, string>, addrs: [bigint, Address][], resolver: Address = SEPOLIA.resolver): Call[] {
  const n = dnsEncode(name);
  return [
    ...Object.entries(texts).map(([key, value]): Call => ({
      to: resolver, describe: `setText(${name}, ${key}, "${value}")`, expect: { kind: 'text', name, key, value },
      data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [n, key, value] }),
    })),
    ...addrs.map(([coinType, a]): Call => ({
      to: resolver, describe: `setAddress(${name}, coinType ${coinType === ETH_COIN_TYPE ? '60 (ETH)' : `0x${coinType.toString(16)}`}, ${getAddress(a)})`,
      expect: { kind: 'addr', name, coinType, address: getAddress(a) },
      data: encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [n, coinType, getAddress(a)] }),
    })),
  ];
}

/** The register call for a member subname in a company registry. */
export function registerMemberCall(registry: Address, label: string, owner: Address, parent: string, expiry: bigint = SEPOLIA.maxExpiry): Call {
  return {
    to: registry, describe: `register(${label}.${parent} → ${getAddress(owner)}, expiry ${expiry})`,
    data: encodeFunctionData({ abi: memberRegistryAbi, functionName: 'register', args: [label, getAddress(owner), '0x0000000000000000000000000000000000000000', SEPOLIA.resolver, NAME_OWNER_ROLES, expiry] }),
  };
}
