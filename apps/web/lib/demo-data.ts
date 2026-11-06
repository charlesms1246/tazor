/**
 * Facts from the live testnet runs on 6 Nov 2026 (Whitechain Sepolia, chain 1874, and Ethereum Sepolia).
 * Nothing here is invented: every hash has a status-1 receipt, every time is a block timestamp or the
 * moment the run wrote its log, and every invoice re-hashes to the invoiceHash the run logged.
 *
 * Sources (copied by hand, not imported):
 *   [setup]   /tmp/tazor-live/setup-demo.log, demo.json        accounts, approvers
 *   [pay]     /tmp/tazor-live/make-payment.ts, pay-meta.txt     how INV-xxxx were built; INV-0042 hash
 *   [p111]    proofs/P1-11_live.md, lib/timings.ts              INV-0042 tx, 3.62 s submit to receipt
 *   [fb]      /tmp/tazor-live/fallback.log                      INV-0043 via Ethereum, 69 s
 *   [credit]  /tmp/tazor-live/credit.sh, credit.log, cn-meta.txt CN-0007
 *   [mandate] /tmp/tazor-live/mandate.sh, mandate.log           mandate on MandateModule v1, 1.5 USDT pull
 *   [revoke]  /tmp/tazor-live/revoke-demo.sh, revoke-demo.log   Ravi: INV-0050 paid, revoked in 3.06 s, INV-0051 refused
 *   [watch]   /tmp/tazor-live/watcher.log                       role sync, lag 84 s
 *   [off]     /tmp/tazor-live/servers-off.sh, servers-off.log, inv60.json, fb-meta.txt  INV-0060, INV-0061 (68 s)
 *   [v2]      scripts/demo-v2/last-run.json + /tmp/tazor-live/demo-v2.log      acme-p2 run
 *   [extras]  scripts/demo-extras/last-run.json + /tmp/tazor-live/demo-extras.log payment runs
 * Block timestamps were read with eth_getTransactionReceipt + eth_getBlockByNumber on both chains.
 */

export const DEMO_RUN_DATE = '2026-11-06';

export const DEMO_TOKEN = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as const;

/** [setup] demo.json, [v2] demo-v2.log preflight. */
export const DEMO_ACCOUNTS = {
  acmeV1: '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6',
  acmeMandate: '0x18d15B034C645dbbFCb9c68238A14D059f632513',
  acmeP2: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
  bluejay: '0xc1dce946D192e344251972470237F1471C93876c',
} as const;

/** Approver accounts by the names the runs used. [setup], [revoke], [v2] */
export const DEMO_PEOPLE = {
  priya: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450',
  cfo: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967',
  ravi: '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb',
  meera: '0x03C291d446b870e0B8F128681937a9eCEDa97763',
} as const;

export type DemoInvoice = {
  id: string;
  /** Base units (6 decimals). */
  amount: string;
  description: string;
  buyer: 'acmeV1' | 'bluejay';
  supplier: 'acmeV1' | 'bluejay';
  supplierName: string;
  /** invoiceHash logged by the run; the seed checks the rebuilt invoice against it. */
  invoiceHash: `0x${string}`;
  approver: keyof typeof DEMO_PEOPLE;
  /** Unix seconds the run built and signed it (log file write time, or the first tx when the log was overwritten). */
  signedAt: number;
  /** Absent when the invoice was never paid. */
  paid?: { tx: `0x${string}`; at: number; title: string; detail: string };
  fallback?: { l1Tx: `0x${string}`; l1At: number; l2Tx: `0x${string}`; l2At: number; seconds: number };
  refused?: { at: number; title: string; detail: string };
};

/** Every make-payment.ts invoice uses this due date and memo. [pay] */
export const DEMO_DUE_DATE = 1794000000;
export const DEMO_MEMO = 'Tazor live demo';

export const DEMO_INVOICES: DemoInvoice[] = [
  {
    // [pay] pay-meta.txt hash; [p111] tx, 3.62 s submit to receipt via the relayer
    id: 'INV-0042', amount: '1200000', description: 'Freight Mumbai-Pune', buyer: 'acmeV1', supplier: 'bluejay', supplierName: 'Bluejay Logistics',
    invoiceHash: '0x5aeb53f98ef4fb798b91a07c920c3190f9c4007cf8d194a83d7634f2e7510cd2', approver: 'priya', signedAt: 1793942738,
    paid: { tx: '0xbceeaa443a3e17a19037a677a459a88dcd11a7e17b01ebd431118c997ce84f21', at: 1793942741, title: 'INV-0042 paid in 3.6 s', detail: 'submit to receipt 3.62 s through the relayer' },
  },
  {
    // [fb] fallback.log: L1 ts 1793942808, L2 ts 1793942877, latency 69 s; signedAt = the L1 forward (its body file was later overwritten)
    id: 'INV-0043', amount: '1200000', description: 'Freight Mumbai-Pune', buyer: 'acmeV1', supplier: 'bluejay', supplierName: 'Bluejay Logistics',
    invoiceHash: '0x3d7743950c774e83268a98099159edeb612409f38c5dfaf60bfa11d1e066fe8f', approver: 'priya', signedAt: 1793942808,
    fallback: { l1Tx: '0x2e387ff547f1100cc6ef5baf780acaf19a220b0b0ce7d140b7dc06e8ec561019', l1At: 1793942808, l2Tx: '0xa00dbd6923b79335f4ee60733adaa0f68652a47915141ddba0e6719b48eea30e', l2At: 1793942877, seconds: 69 },
    paid: { tx: '0xa00dbd6923b79335f4ee60733adaa0f68652a47915141ddba0e6719b48eea30e', at: 1793942877, title: 'INV-0043 paid via Ethereum in 69 s', detail: 'sent on Sepolia, settled on Whitechain through the OptimismPortal' },
  },
  {
    // [credit] credit.sh args, cn-meta.txt hash, credit.log tx
    id: 'CN-0007', amount: '300000', description: 'Credit note: damaged pallet', buyer: 'bluejay', supplier: 'acmeV1', supplierName: 'Acme Steel (credit note)',
    invoiceHash: '0x3d96d6ad448fcf981b495815f7573a004034a3d9e28dacf057b0ffe0757b24db', approver: 'priya', signedAt: 1793943208,
    paid: { tx: '0x4be6a82a6f5a8aa7df415cecda37f693d2e4b09659474765fac407d9da1b4c38', at: 1793943211, title: 'Credit note CN-0007 paid: 0.30 USDT back to Acme', detail: 'Bluejay refunded a damaged pallet in one transaction' },
  },
  {
    // [revoke] INV-0050.json auth.invoiceHash; paid by Ravi before his removal
    id: 'INV-0050', amount: '200000', description: 'Office supplies', buyer: 'acmeV1', supplier: 'bluejay', supplierName: 'Bluejay Logistics',
    invoiceHash: '0x313fdf5fc40d11e477b85ae3471aea92a6470ce47bea310230d33c8d5428fc7e', approver: 'ravi', signedAt: 1793943480,
    paid: { tx: '0x64adc206c7231b292d7278bb2ba05283e33645125f2c8b7bacab8fe8b4e2cb41', at: 1793943483, title: 'INV-0050 paid, approved by Ravi', detail: 'six seconds before Ravi was removed' },
  },
  {
    // [revoke] INV-0051.json auth.invoiceHash; relayer answered HTTP 422 after the revocation; isPaid is still false on PaymentModule v1
    id: 'INV-0051', amount: '200000', description: 'Office supplies', buyer: 'acmeV1', supplier: 'bluejay', supplierName: 'Bluejay Logistics',
    invoiceHash: '0xe12ae27ac33a51cef770bebe320ac53c40769e01494c209d7a21761b39bd5a5e', approver: 'ravi', signedAt: 1793943491,
    refused: { at: 1793943491, title: 'INV-0051 refused: Ravi had been removed', detail: 'his signature no longer counts; a current approver must sign' },
  },
  {
    // [off] servers-off.sh (AMOUNT 300000, "Freight (relayer up)"), inv60.json hash, step 2 tx
    id: 'INV-0060', amount: '300000', description: 'Freight (relayer up)', buyer: 'acmeV1', supplier: 'bluejay', supplierName: 'Bluejay Logistics',
    invoiceHash: '0x342299557d09907192db602b77e3eb6138b9beed3e1df9a5e715e21a3a528b66', approver: 'priya', signedAt: 1793952272,
    paid: { tx: '0xf9ec04c3d37fe699f8bce7b71010022da4234994303d4e373da0e7459982576c', at: 1793952276, title: 'INV-0060 paid through the relayer', detail: 'the relayer was then stopped for INV-0061' },
  },
  {
    // [off] servers-off.log step 5: relayer stopped, L1 ts 1793952300, L2 ts 1793952368, latency 68 s; fb-meta.txt hash
    id: 'INV-0061', amount: '1200000', description: 'Freight Mumbai-Pune', buyer: 'acmeV1', supplier: 'bluejay', supplierName: 'Bluejay Logistics',
    invoiceHash: '0x062bd0b11e7a4c487602a80fb1c9622c13dd9444d6f80c27718d791f401bd647', approver: 'priya', signedAt: 1793952289,
    fallback: { l1Tx: '0xce7a9eddf32c909e8f38c55e7298483d5b0aa55ee4c3fda1f124e3392e74d998', l1At: 1793952300, l2Tx: '0x7722f96724b653b33f329174d569a5629244939244717815120f2ce20a92f500', l2At: 1793952368, seconds: 68 },
    paid: { tx: '0x7722f96724b653b33f329174d569a5629244939244717815120f2ce20a92f500', at: 1793952368, title: 'INV-0061 paid via Ethereum with our servers off, 68 s', detail: 'relayer container stopped; sent through EnsGate on Sepolia' },
  },
];

export type DemoMandate = { id: `0x${string}`; label: string; created: { tx: `0x${string}`; at: number; title: string }; collected: { tx: `0x${string}`; at: number; title: string } };

export const DEMO_MANDATES: DemoMandate[] = [
  {
    // [mandate] mandate.sh: (acme-v2, bluejay, cap 2000000, period 2592000 s); digest, createMandate and pull txs from mandate.log; on MandateModule v1 0xB6f4…aC32
    id: '0x08d47f1cfdc3adfe04d41ce6135822149f4440ebf88fdc6b34612c9049c2e574',
    label: '2.00 / 30 days to 0xc1dce946D192e344251972470237F1471C93876c',
    created: { tx: '0x57117de515ca27dd80638e20c457949e6fa7c1d5d56d6ac8970c784c54d12a1a', at: 1793943058, title: 'Mandate to Bluejay Logistics set up: up to 2 USDT per 30 days' },
    collected: { tx: '0x593e6ac94971ca40c6ee3b8c67f0064a43044ba6bfeabe88181906d4c46210b2', at: 1793943062, title: 'Bluejay collected 1.5 USDT under the mandate, 4 s after setup' },
  },
];

/** A v2 mandate on MandateModuleV2 (acme-p2). Recorded as events only. [v2] step 8 */
export const DEMO_MANDATE_V2 = {
  id: '0x56ab569185166f58e3ba753d4b851110b3344e8331c6a4a3ff937c1794a290b0' as const,
  created: { tx: '0x3bb6068f470e8b8dc275fa363b0402a7df435274892be8bc824729bc48d8097a' as const, at: 1793950100, title: 'Mandate v2 to Bluejay Logistics set up: up to 1 USDT per 30 days' },
  collected: { tx: '0xe03d957ccacaa28750f6790123be182fceed7ab4ff8c39bb26c73ae03f795aca' as const, at: 1793950104, title: 'Bluejay collected 0.6 USDT; a second 0.6 was refused over the cap' },
};

export type DemoRun = { tx: `0x${string}`; at: number; title: string; detail: string };

/** [extras] steps 1 and 2. */
export const DEMO_RUNS: DemoRun[] = [
  { tx: '0xa02d3aed842845a6bddff9869214ca366bfcf5c28413853cd66323a78c63f58d', at: 1793955316, title: 'Payment run: 2 invoices to Bluejay paid in one transaction', detail: '2 x 0.10 USDT, one approval' },
  { tx: '0x2673ffbd1561126a2e21abf26aa8236be6cce89f715beed031eaf01edcdd3f0a', at: 1793955325, title: 'Payment run v2: 2 invoices paid with limits and payee rules applied', detail: '2 x 0.10 USDT from acme-p2' },
];

/** [v2] step 10: EnsGate v2 forward then payFromL1, latency 65 s. */
export const DEMO_FALLBACK_V2 = {
  l1Tx: '0x7d89603aa2b95b792922a30054a0ee82a6ae0fe71b5bc26d6243513a023ae20f' as const, l1At: 1793950212,
  l2Tx: '0x72a01b6cf23f5fbdfa579b869e57f16dcda948bf5dbd0da51f10c15bea2a8e9c' as const, l2At: 1793950277, seconds: 65,
};

export type DemoRoleEvent = { subject: keyof typeof DEMO_PEOPLE; kind: 'role-granted' | 'role-synced' | 'role-revoked'; tx: `0x${string}`; chain: 'whitechain' | 'sepolia'; at: number; title: string; detail?: string };

export const DEMO_ROLES: DemoRoleEvent[] = [
  // [revoke] grant APPROVER ravi on ENS (Sepolia), then syncRoles on Whitechain: 1793943372 to 1793943472 = 100 s (lib/timings.ts)
  { subject: 'ravi', kind: 'role-granted', tx: '0xc6de52196314c651b27cfb769f37855d12b6eb30b24061a3b7a4cdc8baa67516', chain: 'sepolia', at: 1793943372, title: 'Ravi made an approver for acme.taz0r.eth on ENS' },
  { subject: 'ravi', kind: 'role-synced', tx: '0x2798c3911a6b494b0bb5dc65a00c61219d8fda339a182346d84c82bab465bc7e', chain: 'whitechain', at: 1793943472, title: 'Ravi’s role synced to Whitechain 100 s after the ENS change' },
  // [revoke] revoke click to receipt 3.06 s
  { subject: 'ravi', kind: 'role-revoked', tx: '0x027e1cfd06b86adaadab600b98b9444c98178c56ff038ef09daacb3df6ecd6ef', chain: 'whitechain', at: 1793943489, title: 'Ravi removed as approver for acme.taz0r.eth in 3.06 s', detail: 'click to receipt' },
  // [watch] watcher.log lag=84s
  { subject: 'cfo', kind: 'role-synced', tx: '0xddfb4170e6ab70e9c884ba394d5a12e6d3e7885ab9ad35716e6dfdd7d4747ef5', chain: 'whitechain', at: 1793944057, title: 'CFO’s roles synced from ENS to Whitechain in 84 s', detail: 'by the role watcher, no one clicked' },
];

/** Every distinct tx hash above, for checks. */
export const DEMO_TX_HASHES: `0x${string}`[] = [...new Set([
  ...DEMO_INVOICES.flatMap((i) => [i.paid?.tx, i.fallback?.l1Tx, i.fallback?.l2Tx]),
  ...DEMO_MANDATES.flatMap((m) => [m.created.tx, m.collected.tx]),
  DEMO_MANDATE_V2.created.tx, DEMO_MANDATE_V2.collected.tx,
  ...DEMO_RUNS.map((r) => r.tx),
  DEMO_FALLBACK_V2.l1Tx, DEMO_FALLBACK_V2.l2Tx,
  ...DEMO_ROLES.map((r) => r.tx),
].filter((h): h is `0x${string}` => typeof h === 'string'))];
