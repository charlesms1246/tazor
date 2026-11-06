// The ERC-7730 clear-signing files must describe exactly the messages the SDK asks wallets to sign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANCEL_TYPES, CHECKOUT, PERMIT_TYPES, RECEIVE_TYPES, TRANSFER_TYPES, USDT, USDT_DOMAIN, CHECKOUT_DOMAIN } from '../src/checkout.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../../clear-signing/${f}`, import.meta.url), 'utf8'));
type Field = { name: string; type: string };
type Schema = { primaryType: string; types: Record<string, Field[]> };

const checkFile = (file: string, sdk: Record<string, readonly Field[]>, domain: { name?: string; version?: string; chainId?: number | bigint; verifyingContract?: string }) => {
  const d = load(file);
  const e = d.context.eip712;
  assert.equal(e.domain.name, domain.name);
  assert.equal(e.domain.version, domain.version);
  assert.equal(e.domain.chainId, Number(domain.chainId));
  assert.equal(e.domain.verifyingContract.toLowerCase(), String(domain.verifyingContract).toLowerCase());
  for (const [primary, fields] of Object.entries(sdk)) {
    const s = (e.schemas as Schema[]).find((x) => x.primaryType === primary);
    assert.ok(s, `${file} describes ${primary}`);
    assert.deepEqual(s!.types[primary], fields, `${primary} fields match the SDK`);
    const fmt = d.display.formats[primary];
    assert.ok(fmt, `${primary} has a display format`);
    const names = new Set(fields.map((f) => f.name));
    for (const f of fmt.fields) assert.ok(names.has(f.path), `${primary}: ${f.path} exists`);
    for (const p of [...(fmt.required ?? []), ...(fmt.excluded ?? [])]) assert.ok(names.has(p), `${primary}: ${p} exists`);
    const covered = new Set([...fmt.fields.map((f: { path: string }) => f.path), ...(fmt.excluded ?? [])]);
    for (const n of names) assert.ok(covered.has(n), `${primary}: ${n} is shown or deliberately excluded`);
  }
};

test('USDT signatures (pay, refund, x402, permit) match the ERC-7730 file', () => {
  checkFile('eip712-usdt-tazor.json', { ...RECEIVE_TYPES, ...TRANSFER_TYPES, ...PERMIT_TYPES }, USDT_DOMAIN(USDT));
});

test('subscription cancel matches the ERC-7730 file', () => {
  checkFile('eip712-tazor-checkout.json', CANCEL_TYPES, CHECKOUT_DOMAIN(CHECKOUT));
});

test('calldata file covers the checkout functions', () => {
  const d = load('calldata-TazorCheckout.json');
  assert.equal(d.context.contract.deployments[0].address.toLowerCase(), CHECKOUT.toLowerCase());
  for (const k of ['pay(', 'refund(', 'subscribe(', 'charge(', 'cancel(', 'cancelBySig(']) assert.ok(Object.keys(d.display.formats).some((s) => s.startsWith(k)), k);
});
