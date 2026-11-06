import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, size, zeroAddress, type Address, type Hex } from 'viem';
import { ethCall } from './rpc.ts';

export const IS_VERIFIED_ATTRIBUTE: Address = '0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41';
export const VERIFIED: Hex = '0x0000000000000000000000000000000000000001';

export const soulAbi = parseAbi([
  'function soulOf(address addr) view returns (uint256)',
  'function soulAttributeValue(uint256 soulId, address attribute) view returns (bytes20)',
  'function getSigners(uint64 start, uint64 end) view returns (bytes[])',
  'function registryOf(address account) view returns (address)',
]);

type Call = (to: Address, data: Hex) => Promise<Hex>;

async function read<const F extends 'soulOf' | 'soulAttributeValue' | 'getSigners' | 'registryOf'>(
  call: Call, to: Address, functionName: F, args: readonly unknown[],
) {
  const data = await call(to, encodeFunctionData({ abi: soulAbi, functionName, args } as never));
  return decodeFunctionResult({ abi: soulAbi, functionName, data } as never) as unknown;
}

export async function verifiedSoulOf(mirror: Address, person: Address, call: Call = ethCall): Promise<bigint | null> {
  const soulId = (await read(call, mirror, 'soulOf', [person])) as bigint;
  if (soulId === 0n) return null;
  const v = (await read(call, mirror, 'soulAttributeValue', [soulId, IS_VERIFIED_ATTRIBUTE])) as Hex;
  return v.toLowerCase() === VERIFIED ? soulId : null;
}

export type CompanyVerification =
  | { verified: true; admin: Address; soulId: bigint }
  | { verified: false; reason: 'not-a-company' | 'no-verified-admin' };

export async function verifyCompany(
  account: Address,
  opts: { paymentModule: Address; mirror: Address; call?: Call },
): Promise<CompanyVerification> {
  const call = opts.call ?? ethCall;
  const registry = (await read(call, opts.paymentModule, 'registryOf', [account])) as Address;
  if (registry === zeroAddress) return { verified: false, reason: 'not-a-company' };
  const signers = (await read(call, account, 'getSigners', [0n, 32n])) as Hex[];
  for (const s of signers.filter((x) => size(x) === 20)) {
    const admin = getAddress(s);
    const soulId = await verifiedSoulOf(opts.mirror, admin, call);
    if (soulId !== null) return { verified: true, admin, soulId };
  }
  return { verified: false, reason: 'no-verified-admin' };
}
