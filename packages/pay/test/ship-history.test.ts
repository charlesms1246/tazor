import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, pad, parseAbi, toHex, type Address, type Hex } from 'viem';
import { CHECKOUT, DEPOSIT_CHECKOUT, checkoutAbi, historyCsv, merchantHistory, readyToShip, requiredStage, usdtAmount } from '../src/checkout.ts';
import { NETWORKS, pickRequirement } from '../src/x402.ts';

test('readyToShip: under 100 USDT ready on Whitechain; from 100 (inclusive) only once posted to Ethereum; finality only if configured', () => {
  assert.deepEqual(readyToShip('99.99', 'sequencer'), { ready: true, waitFor: 'sequencer', reason: 'Ready to ship: under 100 USDT, confirmation on Whitechain is enough' });
  assert.deepEqual(readyToShip(100_000_000n, 'sequencer'), { ready: false, waitFor: 'ethereum', reason: 'Payment received; waiting for Whitechain to post it to Ethereum (big payments only: 100 USDT and above)' });
  assert.equal(readyToShip('100', 'ethereum').ready, true);
  assert.equal(readyToShip('100', 'finalized').ready, true);
  assert.equal(readyToShip('1', 'pending').ready, false);
  assert.equal(readyToShip('1', null).reason, 'Waiting for the payment to be confirmed on Whitechain');
  assert.equal(requiredStage('5000', { waitForEthereumAbove: '100' }), 'ethereum', 'no final threshold: never waits for finality');
  const strict = { waitForEthereumAbove: '10', waitForFinalAbove: '1000' };
  assert.deepEqual([requiredStage('9', strict), requiredStage('10', strict), requiredStage('1000', strict)], ['sequencer', 'ethereum', 'finalized']);
  assert.deepEqual(readyToShip('1000', 'ethereum', strict), { ready: false, waitFor: 'finalized', reason: 'Payment received; waiting for it to be final (1000 USDT and above)' });
  assert.throws(() => readyToShip('abc', 'sequencer'), /not a USDT amount/);
});

test('x402: eip155:1874 is the primary network; the whitechain-sepolia alias is still payable', () => {
  assert.equal(NETWORKS[0], 'eip155:1874');
  const base = { scheme: 'exact', maxAmountRequired: '10000', payTo: '0x0000000000000000000000000000000000000001', asset: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' };
  assert.equal(pickRequirement([{ ...base, network: 'eip155:1874' }])?.network, 'eip155:1874');
  assert.equal(pickRequirement([{ ...base, network: 'whitechain-sepolia' }])?.network, 'whitechain-sepolia');
  assert.equal(pickRequirement([{ ...base, network: 'base-sepolia' }]), null);
});

const MERCHANT = getAddress('0x6b4e065d08d2cc7723635c6df0cc5268c706cd93');
const PAYER = getAddress('0x00000000000000000000000000000000000000c1');
const CUSTOMER = getAddress('0x00000000000000000000000000000000000000c2');
const ID1 = `0x${'01'.repeat(32)}` as Hex;
const ID2 = `0x${'02'.repeat(32)}` as Hex;
const dep = parseAbi([
  'event DepositPaid(bytes32 indexed id, address indexed merchant, address indexed vault, uint256 amount, uint256 excess, bytes32 ref)',
  'event DepositReturned(bytes32 indexed id, address indexed refundTo, uint256 amount)',
  'function payment(bytes32 id) view returns (address merchant, address refundTo, uint256 amount, uint256 refunded, uint64 paidAt, uint32 refunds)',
]);
const log = (topics: Hex[], data: Hex, block: number, tx: string) => ({ topics, data, blockNumber: toHex(block), transactionHash: `0x${tx.repeat(64 / tx.length)}` });

test('merchantHistory + historyCsv: wallet and deposit payments, refunds and returns, dated by block (one block read each), with a TOTAL row', async () => {
  const blockReads: string[] = [];
  const logs: Record<string, ReturnType<typeof log>[]> = {
    [`${CHECKOUT}:OrderPaid`]: [log(encodeEventTopics({ abi: checkoutAbi, eventName: 'OrderPaid', args: { id: ID1, merchant: MERCHANT, payer: PAYER } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [120_000n, `0x${'aa'.repeat(32)}`]), 100, 'a1')],
    [`${CHECKOUT}:Refunded`]: [log(encodeEventTopics({ abi: checkoutAbi, eventName: 'Refunded', args: { id: ID1, merchant: MERCHANT, payer: PAYER } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [20_000n, 20_000n]), 100, 'a2')],
    [`${DEPOSIT_CHECKOUT}:DepositPaid`]: [log(encodeEventTopics({ abi: dep, eventName: 'DepositPaid', args: { id: ID2, merchant: MERCHANT, vault: '0x00000000000000000000000000000000000000fa' } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [100_000n, 50_000n, `0x${'bb'.repeat(32)}`]), 200, 'b1')],
    [`${DEPOSIT_CHECKOUT}:DepositReturned`]: [log(encodeEventTopics({ abi: dep, eventName: 'DepositReturned', args: { id: ID2, refundTo: CUSTOMER } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [5_000n]), 210, 'b2')],
  };
  const names: Record<string, string> = {};
  for (const n of ['OrderPaid', 'Refunded', 'Subscribed']) names[(encodeEventTopics({ abi: checkoutAbi, eventName: n as 'OrderPaid' }) as Hex[])[0]] = n;
  for (const n of ['DepositPaid', 'DepositReturned']) names[(encodeEventTopics({ abi: dep, eventName: n as 'DepositPaid' }) as Hex[])[0]] = n;
  names[(encodeEventTopics({ abi: parseAbi(['event DepositRefunded(bytes32 indexed id, address indexed merchant, address indexed refundTo, uint256 amount, uint256 totalRefunded)']), eventName: 'DepositRefunded' }) as Hex[])[0]] = 'DepositRefunded';
  const f = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: { address?: Address; topics?: (Hex | Hex[] | null)[] }[] | unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (method === 'eth_blockNumber') return ok(toHex(300));
    if (method === 'eth_getBlockByNumber') { blockReads.push(String(params[0])); return ok({ timestamp: toHex(1_800_000_000 + Number(params[0])) }); }
    if (method === 'eth_call') return ok(encodeFunctionResult({ abi: dep, functionName: 'payment', result: [MERCHANT, CUSTOMER, 100_000n, 0n, 1n, 0] }));
    const q = params[0] as { address: Address; topics: (Hex | Hex[] | null)[] };
    if (q.topics[2] && q.topics[2] !== pad(MERCHANT).toLowerCase()) return ok([]);
    const t0 = q.topics[0] as Hex;
    return ok(logs[`${getAddress(q.address)}:${names[t0]}`] ?? []);
  }) as unknown as typeof fetch;

  const rows = await merchantHistory(MERCHANT, { fetch: f, fromBlock: 0n, chunk: 1000n });
  assert.deepEqual(rows.map((r) => [r.kind, r.method, r.time]), [
    ['paid', 'wallet', 1_800_000_100], ['refunded', 'wallet', 1_800_000_100], ['deposit-paid', 'deposit', 1_800_000_200], ['deposit-returned', 'deposit', 1_800_000_210],
  ]);
  assert.deepEqual(blockReads.sort(), [toHex(100), toHex(200), toHex(210)].sort(), 'each block read once');
  assert.equal((rows[2] as { payer: string }).payer, CUSTOMER, 'the deposit customer is its refund address');

  const csv = historyCsv(rows).trim().split('\n');
  assert.equal(csv[0], 'date_utc,type,order,customer,method,gross_usdt,refund_usdt,net_usdt,detail,transaction,explorer_url');
  const cells = csv.map((l) => l.split(','));
  assert.deepEqual(cells[1].slice(0, 8), ['2027-01-15 08:01:40', 'payment', '0x01010101…', PAYER, 'wallet', '0.12', '0.00', '0.12']);
  assert.deepEqual(cells[2].slice(1, 8), ['refund', '0x01010101…', PAYER, 'wallet', '0.00', '-0.02', '-0.02']);
  assert.deepEqual(cells[3].slice(1, 8), ['payment', '0x02020202…', CUSTOMER, 'deposit', '0.10', '0.00', '0.10']);
  assert.match(csv[3], /excess 0.05 returned to the customer/);
  assert.deepEqual(cells[4].slice(1, 8), ['returned', '0x02020202…', CUSTOMER, 'deposit', '0.00', '0.00', '0.00']);
  assert.equal(cells[1][10], `https://explorer.testnet.whitechain.io/tx/0x${'a1'.repeat(32)}`);
  assert.deepEqual(cells[5].slice(0, 9), ['', 'TOTAL', '', '', '', '0.22', '-0.02', '0.20', '4 events']);
  assert.deepEqual([usdtAmount(1_500_000n), usdtAmount(-20_000n), usdtAmount(1_234_567n), usdtAmount(0n)], ['1.50', '-0.02', '1.234567', '0.00']);

  const without = await merchantHistory(MERCHANT, { fetch: f, fromBlock: 0n, chunk: 1000n, depositCheckout: null });
  assert.deepEqual(without.map((r) => r.kind), ['paid', 'refunded'], 'depositCheckout: null skips deposits');
});
