import {
  concat, encodeFunctionData, getAddress, isAddress, isHex, numberToHex, pad, parseAbi, toHex,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { BadRequest } from './payment.ts';

export const ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

export const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
]);

export const paymasterAbi = parseAbi([
  'function isApproverAccount(address account) view returns (bool)',
  'function verifiedSoulOf(address account) view returns (uint256)',
  'function remaining(uint256 soulId) view returns (uint256 ops, uint256 cost)',
]);

export const SUGGESTED_GAS = {
  verificationGasLimit: 600_000n,
  callGasLimit: 200_000n,
  preVerificationGas: 150_000n,
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 100_000n,
} as const;

const U128 = (1n << 128n) - 1n;

export type UserOp = {
  sender: Address; nonce: bigint; factory?: Address; factoryData?: Hex; callData: Hex;
  callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  paymaster?: Address; paymasterVerificationGasLimit: bigint; paymasterPostOpGasLimit: bigint; paymasterData: Hex; signature: Hex;
};

const qty = (v: unknown, f: string, max: bigint, optional = false): bigint => {
  if (v === undefined && optional) return 0n;
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new BadRequest(`userOp.${f} must be a hex quantity`);
  const n = BigInt(v);
  if (n > max) throw new BadRequest(`userOp.${f} out of range`);
  return n;
};
const bytes = (v: unknown, f: string, optional = false): Hex => {
  if (v === undefined && optional) return '0x';
  if (typeof v !== 'string' || !isHex(v, { strict: true }) || v.length % 2 !== 0) throw new BadRequest(`userOp.${f} must be hex bytes`);
  return v;
};
const address = (v: unknown, f: string, optional = false): Address | undefined => {
  if ((v === undefined || v === null) && optional) return undefined;
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new BadRequest(`userOp.${f} must be an address`);
  return getAddress(v);
};

export function parseUserOp(raw: unknown, { requireSignature }: { requireSignature: boolean }): UserOp {
  if (typeof raw !== 'object' || raw === null) throw new BadRequest('userOp must be an object');
  const o = raw as Record<string, unknown>;
  const op: UserOp = {
    sender: address(o.sender, 'sender')!,
    nonce: qty(o.nonce, 'nonce', (1n << 256n) - 1n),
    factory: address(o.factory, 'factory', true),
    factoryData: bytes(o.factoryData, 'factoryData', true),
    callData: bytes(o.callData, 'callData'),
    callGasLimit: qty(o.callGasLimit, 'callGasLimit', U128, true),
    verificationGasLimit: qty(o.verificationGasLimit, 'verificationGasLimit', U128, true),
    preVerificationGas: qty(o.preVerificationGas, 'preVerificationGas', U128, true),
    maxFeePerGas: qty(o.maxFeePerGas, 'maxFeePerGas', U128, true),
    maxPriorityFeePerGas: qty(o.maxPriorityFeePerGas, 'maxPriorityFeePerGas', U128, true),
    paymaster: address(o.paymaster, 'paymaster', true),
    paymasterVerificationGasLimit: qty(o.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit', U128, true),
    paymasterPostOpGasLimit: qty(o.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit', U128, true),
    paymasterData: bytes(o.paymasterData, 'paymasterData', true),
    signature: bytes(o.signature, 'signature', !requireSignature),
  };
  if (requireSignature && op.signature === '0x') throw new BadRequest('userOp.signature must not be empty');
  return op;
}

const u128 = (v: bigint) => pad(toHex(v), { size: 16 });

export const packUserOp = (op: UserOp) => ({
  sender: op.sender,
  nonce: op.nonce,
  initCode: op.factory ? concat([op.factory, op.factoryData ?? '0x']) : ('0x' as Hex),
  callData: op.callData,
  accountGasLimits: concat([u128(op.verificationGasLimit), u128(op.callGasLimit)]),
  preVerificationGas: op.preVerificationGas,
  gasFees: concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)]),
  paymasterAndData: op.paymaster
    ? concat([op.paymaster, u128(op.paymasterVerificationGasLimit), u128(op.paymasterPostOpGasLimit), op.paymasterData])
    : ('0x' as Hex),
  signature: op.signature,
});

export const encodeHandleOps = (op: UserOp, beneficiary: Address): Hex =>
  encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[packUserOp(op)], beneficiary] });

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** ERC-7677 paymaster web service for SoulQuotaPaymaster (no paymaster signature; eligibility is on-chain). */
export async function paymasterRpc(
  method: string,
  params: unknown,
  deps: { paymaster?: Address; chainId: number; client?: PublicClient },
) {
  if (method !== 'pm_getPaymasterStubData' && method !== 'pm_getPaymasterData') throw new RpcError(-32601, `method not found: ${method}`);
  if (!Array.isArray(params) || params.length < 3) throw new RpcError(-32602, 'params: [userOp, entryPoint, chainId, context?]');
  const [rawOp, ep, chainId] = params;
  if (typeof ep !== 'string' || !isAddress(ep, { strict: false }) || getAddress(ep) !== ENTRY_POINT_V08) {
    throw new RpcError(-32602, `unsupported entryPoint ${String(ep)}; only v0.8 ${ENTRY_POINT_V08}`);
  }
  if (typeof chainId !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chainId) || Number(BigInt(chainId)) !== deps.chainId) {
    throw new RpcError(-32602, `unsupported chainId ${String(chainId)}`);
  }
  if (!deps.paymaster) throw new RpcError(-32000, 'paymaster not configured');
  let op: UserOp;
  try { op = parseUserOp(rawOp, { requireSignature: false }); } catch (e) { throw new RpcError(-32602, (e as Error).message); }

  if (deps.client) {
    const read = <T>(functionName: 'isApproverAccount' | 'verifiedSoulOf', args: readonly unknown[]) =>
      deps.client!.readContract({ address: deps.paymaster!, abi: paymasterAbi, functionName, args } as never) as Promise<T>;
    if (!(await read<boolean>('isApproverAccount', [op.sender]))) throw new RpcError(-32000, 'sender is not a Tazor approver account');
    const soulId = await read<bigint>('verifiedSoulOf', [op.sender]);
    if (soulId === 0n) throw new RpcError(-32000, 'sender is not bound to a verified WB Soul');
    const [opsLeft] = (await deps.client.readContract({ address: deps.paymaster, abi: paymasterAbi, functionName: 'remaining', args: [soulId] })) as readonly [bigint, bigint];
    if (opsLeft === 0n) throw new RpcError(-32000, 'daily sponsorship quota for this WB Soul is used up');
  }

  const q = (v: bigint) => numberToHex(v);
  return {
    paymaster: deps.paymaster,
    paymasterData: '0x',
    paymasterVerificationGasLimit: q(SUGGESTED_GAS.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: q(SUGGESTED_GAS.paymasterPostOpGasLimit),
    callGasLimit: q(op.callGasLimit > SUGGESTED_GAS.callGasLimit ? op.callGasLimit : SUGGESTED_GAS.callGasLimit),
    verificationGasLimit: q(op.verificationGasLimit > SUGGESTED_GAS.verificationGasLimit ? op.verificationGasLimit : SUGGESTED_GAS.verificationGasLimit),
    preVerificationGas: q(op.preVerificationGas > SUGGESTED_GAS.preVerificationGas ? op.preVerificationGas : SUGGESTED_GAS.preVerificationGas),
    ...(method === 'pm_getPaymasterStubData' ? { isFinal: true } : {}),
  };
}
