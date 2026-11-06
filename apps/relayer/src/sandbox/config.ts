import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ADDRESSES } from './abi.ts';

export type SandboxWho = 'operator' | 'admin' | 'ravi' | 'supplier' | 'financier';

export type SandboxConfig = {
  account: Address;
  registry: Address;
  supplier: Address;
  mirrorOperator: Address;
  soulMirror: Address;
  keys: Record<SandboxWho, Hex>;
  /** EOAs of the keys (the operator, and each simulated counterparty's approver signer). */
  eoas: Record<SandboxWho, Address>;
  supplierName: string;
  appUrl: string;
  /** The sandbox company's label in the app's company directory (sandbox.taz0r.eth → 'sandbox'). */
  companyId: string;
  /** Setup's mandate (sandbox → supplier) and listed claim, used when a request names none. */
  mandateId: Hex | null;
  claimId: string | null;
  contracts: { [K in keyof typeof ADDRESSES]: Address };
};

const KEY_ENV: Record<SandboxWho, string> = {
  operator: 'SANDBOX_OPERATOR_KEY', admin: 'SANDBOX_ADMIN_KEY', ravi: 'SANDBOX_RAVI_KEY',
  supplier: 'SANDBOX_SUPPLIER_KEY', financier: 'SANDBOX_FINANCIER_KEY',
};
const ADDR_ENV = ['SANDBOX_ACCOUNT', 'SANDBOX_REGISTRY', 'SANDBOX_SUPPLIER', 'MIRROR_OPERATOR'] as const;

const asKey = (v: string | undefined): Hex | null => {
  const t = v?.trim();
  if (!t) return null;
  const k = (t.startsWith('0x') ? t : `0x${t}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? k : null;
};

/** The sandbox is enabled only when every address and key is set and valid; returns the missing names otherwise. */
export function sandboxFromEnv(env: Record<string, string | undefined>): { config: SandboxConfig | null; missing: string[] } {
  const missing: string[] = [];
  const addr = (name: string): Address | null => {
    const v = env[name]?.trim();
    if (!v || !isAddress(v, { strict: false })) { missing.push(name); return null; }
    return getAddress(v);
  };
  const a = Object.fromEntries(ADDR_ENV.map((n) => [n, addr(n)])) as Record<(typeof ADDR_ENV)[number], Address | null>;
  const keys = {} as Record<SandboxWho, Hex>;
  for (const [who, name] of Object.entries(KEY_ENV) as [SandboxWho, string][]) {
    const k = asKey(env[name]);
    if (!k) missing.push(name); else keys[who] = k;
  }
  if (missing.length) return { config: null, missing };
  const eoas = Object.fromEntries(Object.entries(keys).map(([w, k]) => [w, privateKeyToAccount(k).address])) as Record<SandboxWho, Address>;
  return {
    config: {
      account: a.SANDBOX_ACCOUNT!, registry: a.SANDBOX_REGISTRY!, supplier: a.SANDBOX_SUPPLIER!, mirrorOperator: a.MIRROR_OPERATOR!,
      soulMirror: getAddress(env.WB_SOUL_MIRROR || '0x9822650A99bD33F29E383345F570dAE1e4E00928'),
      keys, eoas,
      supplierName: env.SANDBOX_SUPPLIER_NAME || 'Sandbox Supplier',
      companyId: env.SANDBOX_COMPANY_ID || 'sandbox',
      mandateId: /^0x[0-9a-fA-F]{64}$/.test(env.SANDBOX_MANDATE_ID?.trim() ?? '') ? (env.SANDBOX_MANDATE_ID!.trim() as Hex) : null,
      claimId: /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(env.SANDBOX_CLAIM_ID?.trim() ?? '') ? env.SANDBOX_CLAIM_ID!.trim() : null,
      appUrl: env.SANDBOX_APP_URL || 'https://tazor-app.vercel.app',
      contracts: {
        usdt: getAddress(env.USDT || ADDRESSES.usdt),
        approverFactory: getAddress(env.APPROVER_ACCOUNT_FACTORY || ADDRESSES.approverFactory),
        paymentModuleV1: getAddress(env.PAYMENT_MODULE || ADDRESSES.paymentModuleV1),
        paymentModuleV2: getAddress(env.PAYMENT_MODULE_V2 || ADDRESSES.paymentModuleV2),
        revocationListV2: getAddress(env.REVOCATION_LIST_V2 || ADDRESSES.revocationListV2),
        mandateModuleV2: getAddress(env.MANDATE_MODULE_V2 || ADDRESSES.mandateModuleV2),
        financingModule: getAddress(env.FINANCING_MODULE || ADDRESSES.financingModule),
        roleCache: getAddress(env.ROLE_CACHE || ADDRESSES.roleCache),
      },
    },
    missing: [],
  };
}
