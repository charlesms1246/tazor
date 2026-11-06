// Builds a ReverseOPVerifier proof for one Ethereum Sepolia storage slot and checks it on a
// Whitechain Sepolia fork. Usage: bun prove-slot.ts <anvilRpc> <verifier> <forkBlock> <target> <slot>
import { JsonRpcProvider, Contract, AbiCoder, getBytes, hexlify } from '../vendor/unruggable-gateways/node_modules/ethers/lib.esm/index.js';
import { ReverseOPRollup } from '../vendor/unruggable-gateways/src/op/ReverseOPRollup.js';
import { GatewayRequest } from '../vendor/unruggable-gateways/src/vm.js';
import { EVM_BLOCKHASH_DEPTH } from '../vendor/unruggable-gateways/src/utils.js';

const [anvilRpc, verifierAddr, forkBlockStr, target, slot] = process.argv.slice(2);
const forkBlock = Number(forkBlockStr);
// Needs an RPC that serves eth_getProof for recent blocks (publicnode does not).
const sepolia = new JsonRpcProvider(process.env.SEPOLIA_PROOF_RPC ?? 'https://sepolia.gateway.tenderly.co', 11155111, { staticNetwork: true });
const whitechain = new JsonRpcProvider('https://rpc.testnet.whitechain.io', 1874, { staticNetwork: true });
const anvil = new JsonRpcProvider(anvilRpc, 1874, { staticNetwork: true });

// Search for the L2 block below the fork point instead of below the live head.
class PinnedReverseOPRollup extends ReverseOPRollup {
  override async findL2Block(l1BlockNumber: bigint) {
    let b = forkBlock + 1;
    let a = Math.max(0, b - EVM_BLOCKHASH_DEPTH);
    while (a < b) {
      const middle = Math.floor((a + b) / 2);
      const value = await this.provider2.getStorage(this.L1Block, 0n, middle);
      const block = BigInt('0x' + value.slice(-16));
      if (block == l1BlockNumber) return BigInt(middle);
      if (block > l1BlockNumber) b = middle; else a = middle + 1;
    }
    throw new Error(`unable to find block: ${l1BlockNumber}`);
  }
}

const rollup = new PinnedReverseOPRollup({ provider1: sepolia, provider2: whitechain });
rollup.latestBlockTag = '0x' + (forkBlock - 5).toString(16);
const commit = await rollup.fetchCommit(await rollup.fetchLatestCommitIndex());
const req = new GatewayRequest(1).setTarget(target).setSlot(BigInt(slot)).read().setOutput(0);
const state = await commit.prover.evalRequest(req);
const proofSeq = await commit.prover.prove(state.needs);
const witness = rollup.encodeWitness(commit, proofSeq);

const abi = [
  'function getLatestContext() view returns (bytes)',
  'function getStorageValues(bytes context, tuple(bytes) req, bytes proof) view returns (bytes[] values, uint8 exitCode)',
];
const verifier = new Contract(verifierAddr, abi, anvil);
const context = await verifier.getLatestContext();
const [values, exitCode] = await verifier.getStorageValues(context, [req.encode()], witness);
const direct = await sepolia.getStorage(target, BigInt(slot), Number(commit.index));
const gas = await anvil.estimateGas({ to: verifierAddr, data: verifier.interface.encodeFunctionData('getStorageValues', [context, [req.encode()], witness]) });
console.log(`l1Block(commit)=${commit.index} context=${AbiCoder.defaultAbiCoder().decode(['uint256'], context)[0]}`);
console.log(`proven=${values[0]} exitCode=${exitCode}`);
console.log(`direct=${direct}`);
console.log(`MATCH=${values[0] === direct}`);
console.log(`witnessBytes=${getBytes(witness).length} verifyGas=${gas}`);

const bad = getBytes(witness);
bad[bad.length - 40] ^= 0x01;
try {
  const r = await verifier.getStorageValues(context, [req.encode()], hexlify(bad));
  console.log(`NEGATIVE tampered proof: returned ${r[0][0]} (exit ${r[1]}) -> ${r[0][0] === direct ? 'NOT REJECTED' : 'rejected (different value)'}`);
} catch (e) {
  console.log(`NEGATIVE tampered proof: reverted (${(e as Error).message.slice(0, 80)})`);
}
