import { encodeFunctionData, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { BadRequest, UINT256_MAX, addr, hex, uint } from './payment.ts';

export const mandateModuleAbi = parseAbi([
  'struct Mandate { address account; address payee; uint256 capPerPeriod; uint64 period; uint64 expiry; uint256 nonce; }',
  'function createMandate(Mandate m, address[] approvers, bytes[] signatures) returns (bytes32)',
  'function pull(bytes32 mandateId, uint256 amount)',
  'function mandateOf(bytes32 mandateId) view returns ((address account, uint64 period, bool cancelled, address payee, uint64 start, uint64 cap, uint64 expiry, uint64 spent, uint32 periodIndex))',
]);

/** MandateModuleV2 (Whitechain Sepolia): same createMandate/pull ABI as v1; its EIP-712 domain is ("Tazor", "2"), and the digest is read from the contract. */
export const MANDATE_MODULE_V2: Address = '0x24b6eC6f6bf7e58bB3266b0b2701aE451ab7220F';

const UINT64_MAX = (1n << 64n) - 1n;

export type MandateRequest = {
  mandate: { account: Address; payee: Address; capPerPeriod: bigint; period: bigint; expiry: bigint; nonce: bigint };
  approvers: Address[];
  signatures: Hex[];
};

export function parseMandateRequest(body: unknown): MandateRequest {
  if (typeof body !== 'object' || body === null) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const m = b.mandate as Record<string, unknown> | undefined;
  if (typeof m !== 'object' || m === null) throw new BadRequest('mandate must be an object');
  if (!Array.isArray(b.approvers) || !Array.isArray(b.signatures)) throw new BadRequest('approvers and signatures must be arrays');
  if (b.approvers.length === 0 || b.approvers.length !== b.signatures.length) {
    throw new BadRequest('approvers and signatures must be non-empty and the same length');
  }
  return {
    mandate: {
      account: addr(m.account, 'mandate.account'),
      payee: addr(m.payee, 'mandate.payee'),
      capPerPeriod: uint(m.capPerPeriod, 'mandate.capPerPeriod', UINT256_MAX),
      period: uint(m.period, 'mandate.period', UINT64_MAX),
      expiry: uint(m.expiry, 'mandate.expiry', UINT64_MAX),
      nonce: uint(m.nonce, 'mandate.nonce', UINT256_MAX),
    },
    approvers: b.approvers.map((v, i) => addr(v, `approvers[${i}]`)),
    signatures: b.signatures.map((v, i) => hex(v, `signatures[${i}]`)),
  };
}

export const encodeCreateMandate = (r: MandateRequest): Hex =>
  encodeFunctionData({ abi: mandateModuleAbi, functionName: 'createMandate', args: [r.mandate, r.approvers, r.signatures] });

export function parsePullRequest(body: unknown): { mandateId: Hex; amount: bigint } {
  if (typeof body !== 'object' || body === null) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const amount = uint(b.amount, 'amount', UINT256_MAX);
  if (amount === 0n) throw new BadRequest('amount must be positive');
  return { mandateId: hex(b.mandateId, 'mandateId', 32), amount };
}

export const encodePull = (r: { mandateId: Hex; amount: bigint }): Hex =>
  encodeFunctionData({ abi: mandateModuleAbi, functionName: 'pull', args: [r.mandateId, r.amount] });

const registryAbi = parseAbi(['function registryOf(address account) view returns (address)']);

/** `v2` for a v2 company (configured on PaymentModuleV2), else `v1`; mirrors pickModule. Used for the mandate module and the revocation list. */
export async function pickByAccount(
  client: PublicClient, account: Address, m: { v1: Address; v2: Address; paymentModuleV2: Address },
): Promise<Address> {
  try {
    const reg = await client.readContract({ address: m.paymentModuleV2, abi: registryAbi, functionName: 'registryOf', args: [account] });
    if (!isAddressEqual(reg, zeroAddress)) return m.v2;
  } catch { /* not a v2 company */ }
  return m.v1;
}

/** The module that holds a mandate id: v2 first, then v1; refused if neither knows it. */
export async function findMandateModule(client: PublicClient, mandateId: Hex, m: { v1: Address; v2: Address }): Promise<Address> {
  for (const module of [m.v2, m.v1]) {
    try {
      const s = await client.readContract({ address: module, abi: mandateModuleAbi, functionName: 'mandateOf', args: [mandateId] });
      if (!isAddressEqual(s.account, zeroAddress)) return module;
    } catch { /* not this module */ }
  }
  throw new BadRequest(`unknown mandate ${mandateId} (neither MandateModule v1 nor v2 has it)`);
}

export const pickMandateModule = pickByAccount;
