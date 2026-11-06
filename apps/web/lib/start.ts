/**
 * Merchant onboarding (/start/): the snippet a business pastes into its site, its links, and an optional demo wallet
 * kept in this browser (testnet only) so a business can try it without a wallet of its own.
 */
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Signer, TypedData } from './checkout.ts';

export const START_KEY = 'tazor.start.v1';
const WALLET_KEY = 'tazor.start.demo-wallet.v1';
/** The shared demo relayer signs events for merchants without their own endpoint with this public test secret. */
export const DEMO_WEBHOOK_SECRET = 'whsec_tazor_demo_test';

export type StartForm = { name: string; wallet: string; shipAbove: string; webhook: string; amount: string; ref: string; due: string };
export const START_DEFAULTS: StartForm = { name: '', wallet: '', shipAbove: '100', webhook: '', amount: '10.00', ref: 'ORDER-1001', due: '' };

const store = () => (typeof localStorage === 'undefined' ? null : localStorage);
export function loadStart(): StartForm {
  try { return { ...START_DEFAULTS, ...(JSON.parse(store()?.getItem(START_KEY) ?? '{}') as Partial<StartForm>) }; } catch { return START_DEFAULTS; }
}
export function saveStart(f: StartForm) { try { store()?.setItem(START_KEY, JSON.stringify(f)); } catch { /* storage full */ } }

// ---- the demo wallet (testnet only, this browser only)

export function loadDemoWallet(): Address | null {
  try { const pk = store()?.getItem(WALLET_KEY) as Hex | null; return pk ? privateKeyToAccount(pk).address : null; } catch { return null; }
}
export function createDemoWallet(): Address {
  const existing = loadDemoWallet();
  if (existing) return existing;
  const pk = generatePrivateKey();
  store()?.setItem(WALLET_KEY, pk);
  return privateKeyToAccount(pk).address;
}
/** A signer for the demo wallet when it is `merchant`, so refunds work from /checkout/ in this browser. */
export function demoWalletSigner(merchant: string): Signer | null {
  try {
    const pk = store()?.getItem(WALLET_KEY) as Hex | null;
    if (!pk) return null;
    const account = privateKeyToAccount(pk);
    if (account.address.toLowerCase() !== merchant.toLowerCase()) return null;
    return { address: account.address, signTypedData: (td: TypedData) => account.signTypedData(td as never) };
  } catch { return null; }
}

// ---- validation, in plain English

const AMOUNT = /^\d+(\.\d{1,6})?$/;
export const amountError = (a: string, max = 1000) =>
  !AMOUNT.test(a.trim()) || Number(a) <= 0 ? 'Enter an amount like 10 or 12.50' : Number(a) > max ? `On the test network a link can ask for at most ${max} USDT` : null;
export const shipError = (a: string) => (!AMOUNT.test(a.trim()) ? 'Enter an amount like 100' : null);
export const refError = (r: string) => (!r.trim() ? 'Enter an order number' : r.trim().length > 64 ? 'At most 64 characters' : null);
export const webhookError = (u: string) => {
  if (!u.trim()) return null;
  try { const x = new URL(u.trim()); return x.protocol === 'https:' || x.hostname === 'localhost' ? null : 'Use an https:// address'; } catch { return 'Enter a full address like https://shop.example/tazor-webhook'; }
};

// ---- outputs

/** The snippet a business pastes into its checkout page. */
export function buttonSnippet(o: { origin: string; merchant: string; shipAbove: string; amount: string; ref: string; demoWallet: boolean }): string {
  const m = getAddress(o.merchant);
  return [
    '<!-- Tazor: accept USDT on Whitechain (testnet) -->',
    `<script src="${o.origin}/tazor-pay.js"></script>`,
    '<tazor-pay-button',
    '  mode="wallet"',
    `  merchant="${m}"`,
    `  amount="${o.amount}"`,
    `  order-ref="${o.ref}"`,
    `  ship-above="${o.shipAbove}"`,
    `  demo-wallet="${o.demoWallet ? 'true' : 'false'}"`,
    `  label="Pay ${o.amount} USDT"></tazor-pay-button>`,
    '<script>',
    "  document.querySelector('tazor-pay-button').addEventListener('tazor-paid', (e) => {",
    "    console.log('Paid', e.detail.ref, e.detail.explorerUrl);",
    '  });',
    '</script>',
  ].join('\n');
}

/** A fresh webhook secret for the business to keep (never sent anywhere by this page). */
export function newWebhookSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return `whsec_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** The relayer's WEBHOOKS_JSON entry for this business. */
export const webhookConfig = (merchant: string, url: string, secret: string, shipAbove: string) =>
  JSON.stringify({ [getAddress(merchant)]: { url, secret, shipAbove } }, null, 2);

export const dashboardHref = (merchant: string) => `/checkout/?merchant=${getAddress(merchant)}`;
export const reportsHref = (merchant: string) => `/export/?merchant=${getAddress(merchant)}`;
