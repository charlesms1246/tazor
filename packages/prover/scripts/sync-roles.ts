// Builds a live proof of _roles[0][account] in an ENSv2 registry and prints it as hex.
// Usage: bun sync-roles.ts <registry> <account>
import { JsonRpcProvider, keccak256, AbiCoder } from '../vendor/unruggable-gateways/node_modules/ethers/lib.esm/index.js';
import { ReverseOPRollup } from '../vendor/unruggable-gateways/src/op/ReverseOPRollup.js';
import { GatewayRequest } from '../vendor/unruggable-gateways/src/vm.js';
import { EVM_BLOCKHASH_DEPTH } from '../vendor/unruggable-gateways/src/utils.js';

const [registry, account] = process.argv.slice(2);
const coder = AbiCoder.defaultAbiCoder();
const slot = BigInt(keccak256(coder.encode(['address', 'bytes32'], [account, keccak256(coder.encode(['uint256', 'uint256'], [0, 2]))])));
const sepolia = new JsonRpcProvider(process.env.SEPOLIA_PROOF_RPC ?? 'https://sepolia.gateway.tenderly.co', 11155111, { staticNetwork: true });
const whitechain = new JsonRpcProvider('https://rpc.testnet.whitechain.io', 1874, { staticNetwork: true });
const head = (await whitechain.getBlockNumber()) - 3;

class RecentReverseOPRollup extends ReverseOPRollup {
  override async findL2Block(l1BlockNumber: bigint) {
    let b = head + 1;
    let a = Math.max(0, b - EVM_BLOCKHASH_DEPTH + 40);
    while (a < b) {
      const middle = Math.floor((a + b) / 2);
      const block = BigInt('0x' + (await this.provider2.getStorage(this.L1Block, 0n, middle)).slice(-16));
      if (block == l1BlockNumber) return BigInt(middle);
      if (block > l1BlockNumber) b = middle; else a = middle + 1;
    }
    throw new Error(`unable to find block: ${l1BlockNumber}`);
  }
}
const rollup = new RecentReverseOPRollup({ provider1: sepolia, provider2: whitechain });
rollup.latestBlockTag = '0x' + head.toString(16);
const commit = await rollup.fetchCommit(await rollup.fetchLatestCommitIndex());
const req = new GatewayRequest(1).setTarget(registry).setSlot(slot).read().setOutput(0);
const state = await commit.prover.evalRequest(req);
const witness = rollup.encodeWitness(commit, await commit.prover.prove(state.needs));
const direct = await sepolia.getStorage(registry, slot, Number(commit.index));
console.error(`l1Block=${commit.index} direct=${direct}`);
console.log(witness);
