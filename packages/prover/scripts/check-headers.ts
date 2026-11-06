import { keccak256, toRlp, type Hex } from 'viem';

type Block = Record<string, Hex | undefined> & { hash: Hex; number: Hex };

const SEPOLIA = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const WHITECHAIN = process.env.WC_RPC ?? 'https://rpc.testnet.whitechain.io';

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const uint = (x: Hex | undefined): Hex | undefined => {
  if (x === undefined) return undefined;
  const s = BigInt(x).toString(16);
  return s === '0' ? '0x' : `0x${s.length & 1 ? '0' : ''}${s}`;
};

function encodeHeader(b: Block, glamsterdam: boolean): Hex {
  const fields = [
    b.parentHash, b.sha3Uncles, b.miner, b.stateRoot, b.transactionsRoot, b.receiptsRoot, b.logsBloom,
    uint(b.difficulty), uint(b.number), uint(b.gasLimit), uint(b.gasUsed), uint(b.timestamp), b.extraData, b.mixHash, b.nonce,
    uint(b.baseFeePerGas), b.withdrawalsRoot, uint(b.blobGasUsed), uint(b.excessBlobGas), b.parentBeaconBlockRoot, b.requestsHash,
    ...(glamsterdam ? [b.blockAccessListHash, uint(b.slotNumber)] : []),
  ];
  return toRlp(fields.slice(0, 1 + fields.findLastIndex((x) => x)).map((x) => x || '0x') as Hex[]);
}

async function check(name: string, url: string, back: number[]) {
  const head = BigInt(await rpc<Hex>(url, 'eth_blockNumber', []));
  let ok = true;
  for (const d of back) {
    const b = await rpc<Block>(url, 'eth_getBlockByNumber', [`0x${(head - BigInt(d)).toString(16)}`, false]);
    const before = keccak256(encodeHeader(b, false));
    const after = keccak256(encodeHeader(b, true));
    console.log(`${name} block ${BigInt(b.number)} rpc=${b.hash}\n  unpatched=${before} ${before === b.hash ? 'MATCH' : 'mismatch'}\n  patched  =${after} ${after === b.hash ? 'MATCH' : 'mismatch'}`);
    ok &&= after === b.hash;
  }
  return ok;
}

const ok = (await check('sepolia', SEPOLIA, [3, 2, 1])) && (await check('whitechain', WHITECHAIN, [6, 5]));
if (!ok) process.exit(1);
