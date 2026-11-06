import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
};
const { fetchLogs, historySources, loadChainHistory, mapLogs, mergeEvents } = await import('../lib/chain-history.ts');

// recorded from https://explorer.testnet.whitechain.io/api/v2 and https://eth-sepolia.blockscout.com/api/v2 on 2026-11-06
const fx = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8'));
const FX: Record<string, string> = {
  PaymentModule: 'PM1', PaymentModuleV2: 'PM2', MandateModule: 'MM1', MandateModuleV2: 'MM2', RevocationList: 'RL1',
  RevocationListV2: 'RL2', RoleCache: 'RC', EnsGate: 'G1', EnsGateV2: 'G2',
};
const sources = historySources();
const batches = sources.map((src) => ({ src, logs: fx[FX[src.name]].items }));

const ACME_V2 = '0xb99A12652BEe98429ae31EA0529A0b63f1073721' as const;
const ACME_V1 = '0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6' as const;
const BLUEJAY = '0xc1dce946D192e344251972470237F1471C93876c' as const;
const REGISTRY_V2 = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1' as const;
const count = (xs: { kind: string }[]) => xs.reduce<Record<string, number>>((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});

test('sources: all nine history contracts are configured', () => {
  assert.deepEqual(sources.map((s) => s.name), Object.keys(FX));
  assert.ok(sources.filter((s) => s.chain === 'sepolia').every((s) => s.api.startsWith('https://eth-sepolia.blockscout.com/')));
});

test('mapLogs: a v2 buyer sees its payments, mandate, provisional grants, Ethereum deposit and its registry role syncs', () => {
  const ev = mapLogs(batches, { account: ACME_V2, registries: [REGISTRY_V2] });
  assert.deepEqual(count(ev), { paid: 8, 'role-granted': 2, 'mandate-created': 1, collected: 1, 'role-synced': 7, 'fallback-sent': 1 });
  assert.ok(ev.every((e) => e.source === 'chain' && e.tx?.startsWith('0x') && Number.isFinite(e.at) && e.detail?.startsWith('on-chain')));
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].at <= ev[i].at, 'sorted by time');

  // subject = the invoice hash (the auth nonce as bytes32), amounts and parties decoded from data
  const raw = fx.PM2.items.find((l: { transaction_hash: string }) => l.transaction_hash.startsWith('0x6402d161'));
  const paid = ev.find((e) => e.tx === raw.transaction_hash)!;
  assert.equal(paid.subject, raw.topics[2]);
  assert.equal(paid.at, Date.parse('2026-11-06T08:56:25.000000Z'));
  assert.equal(paid.amount, '100000');
  assert.equal(paid.payee, BLUEJAY);
  assert.equal(paid.chain, 'whitechain');
  assert.match(paid.title, /^Invoice 0x0000…[0-9a-f]{4} paid: 0\.1 USDT from Acme Industries to Bluejay Logistics$/);

  // two InvoicePaid in one tx = a payment run; AgentPaid names the agent
  assert.ok(ev.filter((e) => e.tx?.startsWith('0x2673ffbd')).every((e) => e.title.endsWith('in a payment run (2 invoices)')));
  assert.match(ev.find((e) => e.tx?.startsWith('0x7d6652fe'))!.actor!, /^agent 0x20BA…/);
  assert.match(ev.find((e) => e.tx?.startsWith('0x72a01b6c'))!.detail!, /delivered via Ethereum/);

  const dep = ev.find((e) => e.kind === 'fallback-sent')!;
  assert.equal(dep.chain, 'sepolia');
  assert.match(dep.title, /sent via Ethereum \(acme\.taz0r\.eth\)$/);
  assert.match(ev.find((e) => e.kind === 'collected')!.title, /^Mandate 0x56ab…[0-9a-f]{4} collected 0\.6 USDT$/);
});

test('mapLogs: without a known registry, role syncs are left out', () => {
  assert.equal(mapLogs(batches, { account: ACME_V2 }).filter((e) => e.kind === 'role-synced').length, 0);
});

test('mapLogs: a supplier sees invoices paid to it (and the mandates that pay it); a v1 buyer sees its revocation and deposits', () => {
  const bj = count(mapLogs(batches, { account: BLUEJAY }));
  assert.deepEqual(bj, { paid: 16, 'mandate-created': 2, collected: 2 });
  const v1 = mapLogs(batches, { account: ACME_V1 });
  assert.deepEqual(count(v1), { paid: 8, 'role-revoked': 1, 'fallback-sent': 2 });
  const rev = v1.find((e) => e.kind === 'role-revoked')!;
  assert.equal(rev.subject, rev.subject.toLowerCase());
  assert.match(rev.title, /^0xeD73…[0-9a-fA-F]{4} revoked as an approver of Acme Industries$/);
  assert.equal(mapLogs(batches, { account: '0x000000000000000000000000000000000000dEaD' }).length, 0);
});

test('mapLogs: names this device knows replace the hash in titles', () => {
  const ev = mapLogs(batches, { account: ACME_V2, names: (h) => (h.endsWith('1a1e5') ? 'INV-20261106-ABCD' : null) });
  assert.ok(ev.some((e) => e.title.startsWith('INV-20261106-ABCD paid: 0.1 USDT')));
});

test('mergeEvents: a device event with the same subject, kind and tx is kept once and marked confirmed', () => {
  const chain = mapLogs(batches, { account: ACME_V2, registries: [] }).filter((e) => e.kind === 'paid');
  const c = chain[0];
  const device = [
    { subject: c.subject.toUpperCase().replace('0X', '0x'), kind: 'paid' as const, at: c.at + 5, title: 'INV-1 paid in 2.1 s', detail: 'settled in 2.1 s', tx: c.tx, chain: 'whitechain' as const },
    { subject: c.subject, kind: 'approved' as const, at: c.at - 10_000, title: 'INV-1 approved by 0x00aB…5450' },
  ];
  const merged = mergeEvents(device, chain.filter((e) => e.subject === c.subject));
  const paid = merged.filter((e) => e.kind === 'paid' && e.tx === c.tx);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].title, 'INV-1 paid in 2.1 s');
  assert.equal(paid[0].detail, 'settled in 2.1 s · confirmed on-chain');
  assert.equal(merged[0].kind, 'approved');
  assert.equal(merged.length, 1 + chain.filter((e) => e.subject === c.subject).length);
});

test('fetchLogs: follows next_page_params up to 3 pages', async () => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ items: [fx.PM2.items[0]], next_page_params: { block_number: 12, index: 3, items_count: 50 } }));
  }) as typeof fetch;
  const logs = await fetchLogs(sources[1], f);
  assert.equal(logs.length, 3);
  assert.equal(urls[0], 'https://explorer.testnet.whitechain.io/api/v2/addresses/0x906620D82e2959351c81D731C67EA46DF71E36f3/logs');
  assert.equal(urls[1], `${urls[0]}?block_number=12&index=3&items_count=50`);
});

test('loadChainHistory: a failing explorer is skipped and named; the rest still loads', async () => {
  const f = (async (url: string) => {
    if (url.includes('eth-sepolia')) return new Response('blocked', { status: 503 });
    const src = sources.find((s) => url.includes(s.contract))!;
    return new Response(JSON.stringify(fx[FX[src.name]]));
  }) as typeof fetch;
  const h = await loadChainHistory(ACME_V2, { fetch: f, registries: [REGISTRY_V2], names: () => null });
  assert.deepEqual(h.skipped, ['EnsGate: EnsGate logs: explorer returned 503', 'EnsGateV2: EnsGateV2 logs: explorer returned 503']);
  assert.equal(h.events.filter((e) => e.kind === 'fallback-sent').length, 0);
  assert.equal(h.events.filter((e) => e.kind === 'paid').length, 8);
});
