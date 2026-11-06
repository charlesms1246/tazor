import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, hashTypedData, type Hex } from 'viem';
import {
  BATCH_MODE, ENTRY_POINT_V08, GAS_DEFAULTS, addSignersCallData, applyPaymasterResult, approverAccountAbi, packUserOp, toRpcUserOp, type UserOp,
} from '../lib/userop.ts';

const SENDER = '0x00aBed5bDddf794c415eE746d3E4De5332cC5450';
const op: UserOp = {
  sender: SENDER, nonce: 3n, callData: addSignersCallData(SENDER, ['0x000000000000000000000000000000000000b0b0']),
  callGasLimit: 200000n, verificationGasLimit: 600000n, preVerificationGas: 150000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
  paymaster: '0x0000000000000000000000000000000000007777', paymasterVerificationGasLimit: 200000n, paymasterPostOpGasLimit: 100000n,
  paymasterData: '0xabcd', signature: '0x',
};

test('execute(batch, [addSigners]) calldata targets the account itself', () => {
  const outer = decodeFunctionData({ abi: approverAccountAbi, data: op.callData });
  assert.equal(outer.functionName, 'execute');
  assert.equal(outer.args[0], BATCH_MODE);
  const expectedInner = encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
    [[[SENDER, 0n, '0x96d4110b' + encodeAbiParameters([{ type: 'bytes[]' }], [['0x000000000000000000000000000000000000b0b0']]).slice(2) as Hex]]],
  );
  assert.equal(outer.args[1], expectedInner);
});

test('v0.8 packing reproduces the live EntryPoint getUserOpHash', () => {
  const p = packUserOp(op);
  assert.equal(p.accountGasLimits, '0x000000000000000000000000000927c000000000000000000000000000030d40');
  assert.equal(p.gasFees, '0x0000000000000000000000003b9aca0000000000000000000000000077359400');
  assert.equal(p.paymasterAndData, '0x000000000000000000000000000000000000777700000000000000000000000000030d40000000000000000000000000000186a0abcd');
  const typed = hashTypedData({
    domain: { name: 'ERC4337', version: '1', chainId: 1874, verifyingContract: ENTRY_POINT_V08 },
    types: { PackedUserOperation: [
      { name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' },
      { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' },
    ] },
    primaryType: 'PackedUserOperation',
    message: p,
  });
  assert.equal(typed, '0x2aa412134daf32dbd84745f63316a6211e310fcc98decbdc2a3296238a19445e');
});

test('paymaster results set paymaster fields and override gas only when suggested', () => {
  const base = { ...op, paymaster: undefined, paymasterData: undefined };
  const a = applyPaymasterResult(base, { paymaster: '0x0000000000000000000000000000000000007777', paymasterData: '0x01' });
  assert.equal(a.paymaster, '0x0000000000000000000000000000000000007777');
  assert.equal(a.verificationGasLimit, op.verificationGasLimit);
  assert.equal(a.paymasterVerificationGasLimit, op.paymasterVerificationGasLimit);
  const b = applyPaymasterResult(base, { paymaster: '0x0000000000000000000000000000000000007777', verificationGasLimit: '0xf4240', paymasterVerificationGasLimit: '0x30d40', callGasLimit: 'junk' });
  assert.equal(b.verificationGasLimit, 1_000_000n);
  assert.equal(b.paymasterVerificationGasLimit, 200_000n);
  assert.equal(b.callGasLimit, op.callGasLimit);
  assert.throws(() => applyPaymasterResult(base, {}), /no paymaster/);
});

test('rpc form uses hex quantities and unpacked v0.7+ paymaster fields', () => {
  const r = toRpcUserOp(op);
  assert.equal(r.nonce, '0x3');
  assert.equal(r.verificationGasLimit, '0x927c0');
  assert.equal(r.paymasterVerificationGasLimit, '0x30d40');
  assert.equal(r.paymasterData, '0xabcd');
  assert.ok(!('initCode' in r));
});

test('gas defaults are at least 2x the measured worst case (P-256 Solidity fallback)', () => {
  const measured = { validateUserOp: 271_202n, execute: 25_052n };
  assert.ok(GAS_DEFAULTS.verificationGasLimit >= 2n * measured.validateUserOp);
  assert.ok(GAS_DEFAULTS.callGasLimit >= 2n * measured.execute);
});
