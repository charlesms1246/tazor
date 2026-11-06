import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { BadRequest, UINT256_MAX, addr, hex, uint } from './payment.ts';

export const revocationListAbi = parseAbi([
  'function revoke(address account, address target, address admin, uint256 deadline, bytes sig)',
]);

export type RevokeRequest = { account: Address; target: Address; admin: Address; deadline: bigint; sig: Hex };

export function parseRevokeRequest(body: unknown): RevokeRequest {
  if (typeof body !== 'object' || body === null) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const sig = hex(b.sig, 'sig');
  if (sig.length <= 2) throw new BadRequest('sig must not be empty');
  return {
    account: addr(b.account, 'account'),
    target: addr(b.target, 'target'),
    admin: addr(b.admin, 'admin'),
    deadline: uint(b.deadline, 'deadline', UINT256_MAX),
    sig,
  };
}

export const encodeRevoke = (r: RevokeRequest): Hex =>
  encodeFunctionData({ abi: revocationListAbi, functionName: 'revoke', args: [r.account, r.target, r.admin, r.deadline, r.sig] });
