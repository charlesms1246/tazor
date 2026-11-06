import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { configV2 } from './config-v2.ts';

export type Company = {
  id: 'acme' | 'bluejay';
  ens: string;
  name: string;
  account: Address;
  role: string;
  /** Earlier accounts of the same company (the v1 account, the mandate test account). */
  aliases: Address[];
};

/** The two demo companies on Whitechain Sepolia: Acme buys, Bluejay supplies. */
export const COMPANIES: Company[] = [
  { id: 'acme', ens: 'acme.taz0r.eth', name: 'Acme Industries', account: configV2.demoAccount, role: 'Buyer', aliases: ['0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6', '0x18d15B034C645dbbFCb9c68238A14D059f632513'] },
  { id: 'bluejay', ens: 'bluejay.taz0r.eth', name: 'Bluejay Logistics', account: '0xc1dce946D192e344251972470237F1471C93876c', role: 'Supplier', aliases: [] },
];

const KEY = 'tazor.company.v1';
const EVENT = 'tazor:company';

export function currentCompany(): Company {
  try {
    const id = globalThis.localStorage?.getItem(KEY);
    return COMPANIES.find((c) => c.id === id) ?? COMPANIES[0];
  } catch {
    return COMPANIES[0];
  }
}

export function setCompany(id: Company['id']): void {
  try { globalThis.localStorage?.setItem(KEY, id); } catch { /* storage unavailable */ }
  globalThis.dispatchEvent?.(new Event(EVENT));
}

export const isCompanyAccount = (c: Company, a: string): boolean =>
  [c.account, ...c.aliases].some((x) => x.toLowerCase() === a.toLowerCase());

export const companyByAccount = (a: string): Company | null => COMPANIES.find((c) => isCompanyAccount(c, a)) ?? null;

/** The selected company; Acme on first render so static HTML matches, then the stored choice. */
export function useCompany(): Company {
  const [c, setC] = useState<Company>(COMPANIES[0]);
  useEffect(() => {
    const sync = () => setC(currentCompany());
    sync();
    globalThis.addEventListener(EVENT, sync);
    globalThis.addEventListener('storage', sync);
    return () => { globalThis.removeEventListener(EVENT, sync); globalThis.removeEventListener('storage', sync); };
  }, []);
  return c;
}
