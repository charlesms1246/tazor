import { encodeFunctionData, formatUnits, getAddress, isAddress, isAddressEqual, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { BadRequest } from '../payment.ts';
import { USDT_DOMAIN, authorizationTypes, checkoutAbi } from '../checkout/abi.ts';
import { depositAbi } from '../checkout/deposit-abi.ts';
import type { Checkout } from '../checkout/service.ts';
import type { Deposit } from '../checkout/deposit.ts';
import { demoRequirements, freightQuote, type X402 } from '../checkout/x402.ts';
import { erc20Abi } from './abi.ts';
import type { SandboxConfig } from './config.ts';
import type { ActionResult, SandboxPorts } from './service.ts';
import { SandboxRefused, txUrl } from './service.ts';

export const COMMERCE_ACTIONS = ['checkout-customer-pay', 'checkout-merchant-refund', 'deposit-customer-pay', 'agent-x402', 'fund-demo-wallet'] as const;
export type CommerceAction = (typeof COMMERCE_ACTIONS)[number];

/** Each action spends real test USDT and gas, so each has its own daily cap (per server instance). */
export const COMMERCE_DAILY_CAP: Record<CommerceAction, number> = { 'checkout-customer-pay': 40, 'checkout-merchant-refund': 40, 'deposit-customer-pay': 30, 'agent-x402': 60, 'fund-demo-wallet': 60 };
const DEMO_WALLET_TOPUP = 300_000n; // 0.30 USDT
const CUSTOMER_PAYMENT = 120_000n; // 0.12 USDT
const AGENT_PAYMENT = 10_000n;     // 0.01 USDT, the demo resource's price
const MAX_ORDER = 1_000_000n;

const amountOf = (v: unknown, fallback: bigint, max: bigint): bigint => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string' || !/^\d+(\.\d{1,6})?$/.test(v)) throw new BadRequest('amount must be a USDT decimal string like "0.12"');
  const [i, f = ''] = v.split('.');
  const n = BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0'));
  if (n === 0n) throw new BadRequest('amount must be positive');
  if (n > max) throw new SandboxRefused(`the sandbox pays at most ${formatUnits(max, 6)} USDT here`);
  return n;
};
const usdt = (v: bigint) => `${formatUnits(v, 6)} USDT`;
const ref = (label: string) => keccak256(toHex(`${label}-${Date.now()}-${randomBytes(6).toString('hex')}`));
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toString('base64url');

/**
 * Simulated counterparties for the Checkout chapter: a customer who pays with one signature, an exchange
 * withdrawal to a deposit address, an AI agent paying per request over x402, and (when the presenter has no
 * wallet) the sandbox merchant signing a refund. Customers and agents are fresh keys, funded from the sandbox
 * supplier's test USDT and never stored.
 */
export function createCommerce(o: {
  config: SandboxConfig; ports: SandboxPorts; supplier: PrivateKeyAccount;
  checkout?: Checkout; deposit?: Deposit; x402?: X402; x402PayTo?: Address; relayerUrl?: string;
  /** The relayer's gas budget and balance floor. */
  budget?: () => Promise<void>;
}) {
  const { config: c, ports: p } = o;
  const token = c.contracts.usdt;
  const used = new Map<string, number>();
  const nowSec = () => BigInt(Math.floor(p.now() / 1000));

  const cap = (a: CommerceAction) => {
    const key = `${a}:${Math.floor(p.now() / 86_400_000)}`;
    const n = used.get(key) ?? 0;
    if (n >= COMMERCE_DAILY_CAP[a]) throw new SandboxRefused(`the sandbox runs "${a}" at most ${COMMERCE_DAILY_CAP[a]} times a day; try again tomorrow`);
    used.set(key, n + 1);
  };
  /** The supplier wallet funds customers, agents and deposits: refuse clearly when it runs low. */
  const supplierHas = async (need: bigint) => {
    const bal = await p.read<bigint>('whitechain', token, erc20Abi, 'balanceOf', [c.eoas.supplier]);
    if (bal < need) throw new SandboxRefused(`the sandbox supplier wallet (${c.eoas.supplier}) has ${usdt(bal)}, needs ${usdt(need)}: top it up with test USDT`);
  };
  const fund = async (to: Address, amount: bigint): Promise<Hex> => {
    const tx = await p.send('whitechain', 'supplier', token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }));
    await p.wait('whitechain', tx);
    return tx;
  };
  const sign3009 = (who: PrivateKeyAccount, primaryType: 'ReceiveWithAuthorization' | 'TransferWithAuthorization', m: { to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }) =>
    who.signTypedData({ domain: { ...USDT_DOMAIN, verifyingContract: token }, types: authorizationTypes, primaryType, message: { from: who.address, ...m } });
  const merchantOf = (v: unknown): Address => {
    if (v === undefined || v === null || v === '') return c.eoas.supplier;
    if (typeof v !== 'string' || !isAddress(v)) throw new BadRequest('merchant must be an address');
    return getAddress(v);
  };
  const res = (action: CommerceAction, status: string, tx: Hex | null, detail: string, extra: Record<string, unknown>): ActionResult =>
    ({ action, status, tx, chain: 'whitechain', explorerUrl: txUrl('whitechain', tx), detail, ...extra });

  const funded = new Map<string, number>();
  const handlers: Record<CommerceAction, (q: Record<string, unknown>) => Promise<ActionResult>> = {
    /** A wallet created inside a demo page (no extension, testnet only) gets 0.30 test USDT once a day to pay with. */
    async 'fund-demo-wallet'(q) {
      if (typeof q.address !== 'string' || !isAddress(q.address)) throw new BadRequest('address must be an address');
      const who = getAddress(q.address);
      const day = Math.floor(p.now() / 86_400_000);
      if (funded.get(who) === day) throw new SandboxRefused('this demo wallet was already topped up today');
      const bal = await p.read<bigint>('whitechain', token, erc20Abi, 'balanceOf', [who]);
      if (bal >= DEMO_WALLET_TOPUP) return res('fund-demo-wallet', 'enough', null, `The demo wallet already holds ${usdt(bal)}`, { address: who, balance: bal.toString() });
      cap('fund-demo-wallet');
      await o.budget?.();
      await supplierHas(DEMO_WALLET_TOPUP - bal);
      funded.set(who, day);
      const tx = await fund(who, DEMO_WALLET_TOPUP - bal);
      return res('fund-demo-wallet', 'funded', tx, `The demo wallet received ${usdt(DEMO_WALLET_TOPUP - bal)} of test USDT (no WBT)`, { address: who, txHash: tx });
    },

    /** A customer with USDT and no WBT pays an order with one signature (EIP-3009); the relayer submits. */
    async 'checkout-customer-pay'(q) {
      if (!o.checkout) throw new SandboxRefused('checkout is not configured on this relayer');
      const amount = amountOf(q.amount, CUSTOMER_PAYMENT, MAX_ORDER);
      const merchant = merchantOf(q.merchant);
      cap('checkout-customer-pay');
      await o.budget?.();
      await supplierHas(amount);
      const customer = privateKeyToAccount(generatePrivateKey());
      const fundTx = await fund(customer.address, amount);
      const now = nowSec();
      const order = { merchant, amount, ref: ref('autopilot-order'), deadline: now + 3600n };
      const nonce = await p.read<Hex>('whitechain', o.checkout.address, checkoutAbi as unknown as Abi, 'payNonce', [order]);
      const validAfter = now - 60n;
      const validBefore = now + 600n;
      const signature = await sign3009(customer, 'ReceiveWithAuthorization', { to: o.checkout.address, value: amount, validAfter, validBefore, nonce });
      const paid = await o.checkout.pay({
        order: { merchant, amount: amount.toString(), ref: order.ref, deadline: order.deadline.toString() },
        payer: customer.address, validAfter: validAfter.toString(), validBefore: validBefore.toString(), signature,
      });
      return res('checkout-customer-pay', 'paid', paid.txHash, `A customer paid ${usdt(amount)} with one signature (no WBT); the relayer submitted it`, {
        orderId: paid.orderId, txHash: paid.txHash, customer: customer.address, merchant, amount: amount.toString(), fundTx, ref: order.ref,
      });
    },

    /** No presenter wallet: the sandbox merchant (supplier key) signs a refund; only for orders paid to it. */
    async 'checkout-merchant-refund'(q) {
      if (!o.checkout) throw new SandboxRefused('checkout is not configured on this relayer');
      const id = q.orderId ?? q.id;
      if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw new BadRequest('orderId must be a 32-byte hex');
      const amount = amountOf(q.amount, 20_000n, MAX_ORDER);
      cap('checkout-merchant-refund');
      await o.budget?.();
      const [merchant, , paidAmount, refunded, paidAt, refunds] = await p.read<readonly [Address, Address, bigint, bigint, bigint, number]>('whitechain', o.checkout.address, checkoutAbi as unknown as Abi, 'payment', [id]);
      if (BigInt(paidAt) === 0n) throw new SandboxRefused('that order is not paid');
      if (!isAddressEqual(merchant, c.eoas.supplier)) throw new SandboxRefused('the sandbox can only refund orders paid to the sandbox merchant; refund from your own wallet');
      if (refunded + amount > paidAmount) throw new SandboxRefused(`at most ${usdt(paidAmount - refunded)} can still be refunded`);
      const nonce = await p.read<Hex>('whitechain', o.checkout.address, checkoutAbi as unknown as Abi, 'refundNonce', [id, amount, BigInt(refunds)]);
      const now = nowSec();
      const signature = await sign3009(o.supplier, 'ReceiveWithAuthorization', { to: o.checkout.address, value: amount, validAfter: now - 60n, validBefore: now + 600n, nonce });
      const r = await o.checkout.refund({ id, amount: amount.toString(), refundNo: String(refunds), validAfter: (now - 60n).toString(), validBefore: (now + 600n).toString(), signature });
      return res('checkout-merchant-refund', 'refunded', r.txHash, `The merchant refunded ${usdt(amount)}; it goes back to the customer only`, { orderId: id, txHash: r.txHash, amount: amount.toString() });
    },

    /** An exchange withdrawal (WhiteBIT, simulated): a plain USDT transfer to the order's deposit address; the status poll settles it. */
    async 'deposit-customer-pay'(q) {
      if (!o.deposit) throw new SandboxRefused('deposit checkout is not configured on this relayer');
      const given = q.order as Record<string, unknown> | undefined;
      const now = nowSec();
      const order = given && typeof given === 'object'
        ? { merchant: merchantOf(given.merchant), amount: amountOf(typeof given.amount === 'string' && /^\d+$/.test(given.amount) ? formatUnits(BigInt(given.amount), 6) : given.amount, 100_000n, MAX_ORDER), ref: String(given.ref) as Hex, deadline: BigInt(String(given.deadline)), refundTo: merchantOf(given.refundTo ?? c.eoas.supplier) }
        : { merchant: merchantOf(q.merchant), amount: amountOf(q.amount, 100_000n, MAX_ORDER), ref: ref('autopilot-deposit'), deadline: now + 3600n, refundTo: c.eoas.supplier };
      if (!/^0x[0-9a-fA-F]{64}$/.test(order.ref)) throw new BadRequest('order.ref must be a 32-byte hex');
      cap('deposit-customer-pay');
      await o.budget?.();
      await supplierHas(order.amount);
      const depositAddress = await p.read<Address>('whitechain', o.deposit.address, depositAbi as unknown as Abi, 'depositAddress', [order]);
      const tx = await fund(depositAddress, order.amount);
      return res('deposit-customer-pay', 'transferred', tx, `A plain transfer of ${usdt(order.amount)} arrived at the order's deposit address, as from an exchange withdrawal (simulated); polling the order settles it`, {
        order: { ...order, amount: order.amount.toString(), deadline: order.deadline.toString() }, orderParam: b64url(order), depositAddress, txHash: tx,
      });
    },

    /** An AI agent with a fresh key and 0.01 USDT buys one freight quote through the x402 facilitator. */
    async 'agent-x402'(q) {
      if (!o.x402 || !o.x402PayTo) throw new SandboxRefused('the x402 facilitator or its demo payTo is not configured');
      const from = typeof q.from === 'string' && q.from ? q.from.slice(0, 40) : 'Mumbai';
      const to = typeof q.to === 'string' && q.to ? q.to.slice(0, 40) : 'Pune';
      cap('agent-x402');
      await o.budget?.();
      await supplierHas(AGENT_PAYMENT);
      const agent = privateKeyToAccount(generatePrivateKey());
      const fundTx = await fund(agent.address, AGENT_PAYMENT);
      const resource = `${(o.relayerUrl ?? 'https://tazor-relayer.vercel.app').replace(/\/+$/, '')}/x402/demo/freight-quote?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const requirements = demoRequirements(resource, o.x402PayTo, token);
      const now = nowSec();
      const authorization = { from: agent.address, to: o.x402PayTo, value: AGENT_PAYMENT.toString(), validAfter: (now - 60n).toString(), validBefore: (now + 300n).toString(), nonce: toHex(randomBytes(32)) };
      const signature = await sign3009(agent, 'TransferWithAuthorization', { to: o.x402PayTo, value: AGENT_PAYMENT, validAfter: now - 60n, validBefore: now + 300n, nonce: authorization.nonce });
      const settled = await o.x402.settle({ x402Version: 1, paymentPayload: { x402Version: 1, scheme: 'exact', network: 'eip155:1874', payload: { signature, authorization } }, paymentRequirements: requirements });
      if (!settled.success) throw new SandboxRefused(`the facilitator refused the agent's payment: ${settled.errorReason}`);
      return res('agent-x402', 'paid', settled.transaction as Hex, `An AI agent paid ${usdt(AGENT_PAYMENT)} over x402 and got a freight quote (${from} → ${to})`, {
        quote: freightQuote(from, to), txHash: settled.transaction, agent: agent.address, payTo: o.x402PayTo, fundTx, resource,
      });
    },
  };
  return { handlers, explorer: (tx: Hex) => txUrl('whitechain', tx) };
}
