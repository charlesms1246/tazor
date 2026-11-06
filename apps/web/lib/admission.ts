/** "Ask your admin to add you": the admin's one-line command, and a live check of each admission step. */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { config } from './config.ts';
import { rpc } from './rpc.ts';
import { verifiedSoulOf } from './soul.ts';

export const ROLE_APPROVER = 1n << 64n;
const roleCacheAbi = parseAbi(['function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)']);
const SAFE_ID = /^[a-z0-9-]{1,32}$/;

/** The command a company admin runs from the tazor repo. Only hex and a plain company id go into it. */
export function admitCommand(approverAccount: string, signer: string, company: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(approverAccount)) throw new Error('approver account must be an address');
  if (!/^0x[0-9a-fA-F]+$/.test(signer)) throw new Error('signer must be hex');
  if (!SAFE_ID.test(company)) throw new Error('company id must be lowercase letters, digits or dashes');
  return `SIGNER=${signer} zsh scripts/admit-approver.sh ${approverAccount} ${company}`;
}

export type Admission = { deployed: boolean | null; verified: boolean | null; approver: boolean | null };

/** Each step read live from Whitechain Sepolia; null when it could not be read. */
export async function checkAdmission(account: Address, registry: Address | null): Promise<Admission> {
  const [deployed, verified, approver] = await Promise.all([
    rpc<Hex>('eth_getCode', [account, 'latest']).then((c) => !!c && c !== '0x').catch(() => null),
    config.wbSoulMirror ? verifiedSoulOf(config.wbSoulMirror, account).then((s) => s !== null).catch(() => null) : Promise.resolve(null),
    registry && config.roleCache
      ? rpc<Hex>('eth_call', [{ to: config.roleCache, data: encodeFunctionData({ abi: roleCacheAbi, functionName: 'rolesOf', args: [registry, account] }) }, 'latest'])
        .then((d) => ((decodeFunctionResult({ abi: roleCacheAbi, functionName: 'rolesOf', data: d }) as readonly [bigint, bigint])[0] & ROLE_APPROVER) !== 0n)
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  return { deployed, verified, approver };
}

export const admitted = (a: Admission) => a.deployed === true && a.verified === true && a.approver === true;
