import {
  concat, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, numberToHex, pad, parseAbi, toHex, type Address, type Hex,
} from 'viem';

export const ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

export const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
]);

export const approverAccountAbi = parseAbi([
  'function execute(bytes32 mode, bytes executionData) payable',
  'function addSigners(bytes[] signers)',
  'function isSigner(bytes signer) view returns (bool)',
]);

export const BATCH_MODE: Hex = '0x0100000000000000000000000000000000000000000000000000000000000000';

export const GAS_DEFAULTS = {
  verificationGasLimit: 600_000n,
  callGasLimit: 200_000n,
  preVerificationGas: 150_000n,
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 100_000n,
} as const;

export type UserOp = {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
};

export function addSignersCallData(account: Address, signers: Hex[]): Hex {
  const inner = encodeFunctionData({ abi: approverAccountAbi, functionName: 'addSigners', args: [signers] });
  const batch = encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }],
    [[{ target: account, value: 0n, callData: inner }]],
  );
  return encodeFunctionData({ abi: approverAccountAbi, functionName: 'execute', args: [BATCH_MODE, batch] });
}

const u128 = (v: bigint) => pad(toHex(v), { size: 16 });

export function packUserOp(op: UserOp) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: '0x' as Hex,
    callData: op.callData,
    accountGasLimits: concat([u128(op.verificationGasLimit), u128(op.callGasLimit)]),
    preVerificationGas: op.preVerificationGas,
    gasFees: concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)]),
    paymasterAndData: op.paymaster
      ? concat([op.paymaster, u128(op.paymasterVerificationGasLimit ?? 0n), u128(op.paymasterPostOpGasLimit ?? 0n), op.paymasterData ?? '0x'])
      : ('0x' as Hex),
    signature: op.signature,
  };
}

export const encodeGetUserOpHash = (op: UserOp) =>
  encodeFunctionData({ abi: entryPointAbi, functionName: 'getUserOpHash', args: [packUserOp(op)] });
export const decodeGetUserOpHash = (data: Hex) =>
  decodeFunctionResult({ abi: entryPointAbi, functionName: 'getUserOpHash', data });
export const encodeGetNonce = (sender: Address) =>
  encodeFunctionData({ abi: entryPointAbi, functionName: 'getNonce', args: [sender, 0n] });
export const encodeIsSigner = (signer: Hex) =>
  encodeFunctionData({ abi: approverAccountAbi, functionName: 'isSigner', args: [signer] });
export const decodeIsSigner = (data: Hex) =>
  decodeFunctionResult({ abi: approverAccountAbi, functionName: 'isSigner', data });

export function toRpcUserOp(op: UserOp) {
  const q = (v: bigint | undefined) => (v === undefined ? undefined : numberToHex(v));
  return {
    sender: op.sender, nonce: q(op.nonce), callData: op.callData,
    callGasLimit: q(op.callGasLimit), verificationGasLimit: q(op.verificationGasLimit), preVerificationGas: q(op.preVerificationGas),
    maxFeePerGas: q(op.maxFeePerGas), maxPriorityFeePerGas: q(op.maxPriorityFeePerGas),
    ...(op.paymaster ? {
      paymaster: op.paymaster, paymasterVerificationGasLimit: q(op.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: q(op.paymasterPostOpGasLimit), paymasterData: op.paymasterData ?? '0x',
    } : {}),
    signature: op.signature,
  };
}

type PmResult = Partial<Record<
  'paymaster' | 'paymasterData' | 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit' | 'callGasLimit'
  | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas', string>>;

const big = (v: string | undefined, fallback: bigint) => (v !== undefined && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : fallback);

export function applyPaymasterResult(op: UserOp, r: PmResult): UserOp {
  if (!r.paymaster || !/^0x[0-9a-fA-F]{40}$/.test(r.paymaster)) throw new Error('paymaster service returned no paymaster');
  return {
    ...op,
    paymaster: r.paymaster as Address,
    paymasterData: (r.paymasterData ?? '0x') as Hex,
    paymasterVerificationGasLimit: big(r.paymasterVerificationGasLimit, op.paymasterVerificationGasLimit ?? GAS_DEFAULTS.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: big(r.paymasterPostOpGasLimit, op.paymasterPostOpGasLimit ?? GAS_DEFAULTS.paymasterPostOpGasLimit),
    callGasLimit: big(r.callGasLimit, op.callGasLimit),
    verificationGasLimit: big(r.verificationGasLimit, op.verificationGasLimit),
    preVerificationGas: big(r.preVerificationGas, op.preVerificationGas),
    maxFeePerGas: big(r.maxFeePerGas, op.maxFeePerGas),
    maxPriorityFeePerGas: big(r.maxPriorityFeePerGas, op.maxPriorityFeePerGas),
  };
}

export async function relayerRpc<T>(relayerUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${relayerUrl}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error('Relayer unreachable.'); });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method}: ${json.error?.message ?? json.error ?? `HTTP ${res.status}`}`);
  return json.result as T;
}

export async function submitUserOp(relayerUrl: string, op: UserOp): Promise<Hex> {
  const res = await fetch(`${relayerUrl}/userop`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userOp: toRpcUserOp(op) }), signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw new Error('Relayer unreachable.'); });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`relayer /userop failed (HTTP ${res.status}): ${json.error ?? 'no details'}`);
  if (typeof json.txHash !== 'string') throw new Error('relayer /userop returned no txHash');
  return json.txHash as Hex;
}
