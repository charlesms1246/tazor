import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, stringToBytes, toHex, type Hex } from 'viem';
import { checkoutAbi, depositAbi } from '../lib/checkout.ts';

export const CHECKOUT = '0x8Ce727e6B4099b68f667B1ffEcAd7e1BeB511670';
export const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c';
export const PAYER = '0x00000000000000000000000000000000000A11cE';
export const OTHER = '0x000000000000000000000000000000000000b0b0';
export const ORDER = keccak256(stringToBytes('test order BJ-77')) as Hex;
export const SUB = keccak256(stringToBytes('test sub')) as Hex;

type Ev = { eventName: string; args: Record<string, unknown>; data: Hex; block: number; tx: Hex; at: string };
const topics = (e: Ev) => encodeEventTopics({ abi: checkoutAbi, eventName: e.eventName as never, args: e.args as never }) as Hex[];

export const events: Ev[] = [
  { eventName: 'OrderPaid', args: { id: ORDER, merchant: BLUEJAY, payer: PAYER }, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [1_550_000n, keccak256(stringToBytes('BJ-77'))]), block: 12_400_000, tx: `0x${'aa'.repeat(32)}`, at: '2026-11-06T20:00:00.000000Z' },
  { eventName: 'Refunded', args: { id: ORDER, merchant: BLUEJAY, payer: PAYER }, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [500_000n, 500_000n]), block: 12_400_100, tx: `0x${'bb'.repeat(32)}`, at: '2026-11-06T20:10:00.000000Z' },
  { eventName: 'OrderPaid', args: { id: keccak256(stringToBytes('other')), merchant: OTHER, payer: PAYER }, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [9_000_000n, keccak256(stringToBytes('X'))]), block: 12_400_200, tx: `0x${'cc'.repeat(32)}`, at: '2026-11-06T20:20:00.000000Z' },
  { eventName: 'Subscribed', args: { id: SUB, merchant: BLUEJAY, payer: PAYER }, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint32' }, { type: 'uint16' }, { type: 'bytes32' }], [1_000_000n, 60, 3, keccak256(stringToBytes('plan'))]), block: 12_400_300, tx: `0x${'dd'.repeat(32)}`, at: '2026-11-01T20:30:00.000000Z' },
  { eventName: 'Charged', args: { id: SUB }, data: encodeAbiParameters([{ type: 'uint16' }, { type: 'uint256' }], [1, 1_000_000n]), block: 12_400_300, tx: `0x${'dd'.repeat(32)}`, at: '2026-11-01T20:30:00.000000Z' },
];

/** Blockscout v2 log items (newest first, as the explorer returns them). */
export const explorerItems = () => events.map((e, i) => ({
  block_number: e.block, block_timestamp: e.at, data: e.data, topics: [...topics(e), null].slice(0, 4), transaction_hash: e.tx, index: i,
})).reverse();

/** eth_getLogs results for the order (RPC shape). */
export const rpcOrderLogs = () => events.filter((e) => (e.args as { id: Hex }).id === ORDER).map((e, i) => ({
  address: CHECKOUT, topics: topics(e), data: e.data, blockNumber: toHex(e.block), transactionHash: e.tx, logIndex: toHex(i),
}));

export const paymentResult = () => encodeFunctionResult({ abi: checkoutAbi, functionName: 'payment', result: [BLUEJAY, PAYER, 1_550_000n, 500_000n, 1_794_002_400n, 1] as never });

// ---- TazorDepositCheckout (paid by a plain transfer to a deposit address)
export const DEPOSIT = '0xcb3515398C8Cd9459a1Dce75aB42ec664a07B3ab';
export const VAULT = '0x000000000000000000000000000000000000da00';
export const REFUND_TO = '0x000000000000000000000000000000000000fe00';
export const DEP_ORDER = keccak256(stringToBytes('test deposit order BJ-88')) as Hex;

const dTopics = (e: Ev) => encodeEventTopics({ abi: depositAbi, eventName: e.eventName as never, args: e.args as never }) as Hex[];
export const depositEvents: Ev[] = [
  { eventName: 'DepositPaid', args: { id: DEP_ORDER, merchant: BLUEJAY, vault: VAULT }, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [2_000_000n, 250_000n, keccak256(stringToBytes('BJ-88'))]), block: 12_400_400, tx: `0x${'d1'.repeat(32)}`, at: '2026-11-06T20:40:00.000000Z' },
  { eventName: 'DepositReturned', args: { id: DEP_ORDER, refundTo: REFUND_TO }, data: encodeAbiParameters([{ type: 'uint256' }], [250_000n]), block: 12_400_400, tx: `0x${'d1'.repeat(32)}`, at: '2026-11-06T20:40:00.000000Z' },
];
export const depositExplorerItems = () => depositEvents.map((e, i) => ({
  block_number: e.block, block_timestamp: e.at, data: e.data, topics: [...dTopics(e), null].slice(0, 4), transaction_hash: e.tx, index: i,
})).reverse();
export const rpcDepositLogs = () => depositEvents.map((e, i) => ({
  address: DEPOSIT, topics: dTopics(e), data: e.data, blockNumber: toHex(e.block), transactionHash: e.tx, logIndex: toHex(i),
}));
export const depositPaymentResult = () => encodeFunctionResult({ abi: depositAbi, functionName: 'payment', result: [BLUEJAY, REFUND_TO, 2_000_000n, 0n, 1_794_003_000n, 0] as never });
