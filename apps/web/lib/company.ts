import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { configV2 } from './config-v2.ts';
import { DIRECTORY_EVENT, cachedDirectory, refreshDirectory, type Directory } from './ens-directory.ts';

export type Company = {
  /** ENS label under taz0r.eth. Typed as the demo labels until every caller accepts any label; ENS may add others. */
  id: 'acme' | 'bluejay';
  ens: string;
  name: string;
  account: Address;
  role: string;
  /** Earlier accounts of the same company (the v1 account, the mandate test account). */
  aliases: Address[];
};

/** Static demo companies: the first render and the fallback when ENS has no data. Replaced in place from ENS. */
const STATIC_COMPANIES: Company[] = [
  { id: 'acme', ens: 'acme.taz0r.eth', name: 'Acme Industries', account: configV2.demoAccount, role: 'Buyer', aliases: ['0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6', '0x18d15B034C645dbbFCb9c68238A14D059f632513'] },
  { id: 'bluejay', ens: 'bluejay.taz0r.eth', name: 'Bluejay Logistics', account: '0xc1dce946D192e344251972470237F1471C93876c', role: 'Supplier', aliases: [] },
];

/**
 * Companies registered under taz0r.eth that have a Whitechain account (ENSIP-11 address, or the labelled fallback).
 * Starts as the static list so static HTML matches, then is updated in place from the ENS directory.
 */
export const COMPANIES: Company[] = [...STATIC_COMPANIES];

/** Companies from an ENS directory; known demo companies first (keeping their earlier accounts), then any others. */
export function companiesFromDirectory(d: Directory | null): Company[] {
  if (!d) return [...STATIC_COMPANIES];
  const list = d.companies
    .filter((c) => c.account)
    .map((c): Company => ({
      id: c.label as Company['id'], ens: c.ens, name: c.name, account: c.account!, role: c.role ?? 'Company',
      aliases: STATIC_COMPANIES.find((x) => x.id === c.label)?.aliases ?? [],
    }));
  if (list.length === 0) return [...STATIC_COMPANIES];
  const rank = (id: string) => { const i = STATIC_COMPANIES.findIndex((c) => c.id === id); return i < 0 ? STATIC_COMPANIES.length : i; };
  return list.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function applyDirectory(d: Directory | null): void {
  const next = companiesFromDirectory(d);
  const same = next.length === COMPANIES.length && next.every((c, i) => JSON.stringify(c) === JSON.stringify(COMPANIES[i]));
  if (!same) COMPANIES.splice(0, COMPANIES.length, ...next);
}

/** All companies, ENS-backed after mount (static on first render). */
export function useCompanies(): Company[] {
  const [list, setList] = useState<Company[]>(STATIC_COMPANIES);
  useEffect(() => {
    const sync = () => { applyDirectory(cachedDirectory()); setList([...COMPANIES]); };
    sync();
    void refreshDirectory().then(sync);
    globalThis.addEventListener(DIRECTORY_EVENT, sync);
    return () => globalThis.removeEventListener(DIRECTORY_EVENT, sync);
  }, []);
  return list;
}

const KEY = 'tazor.company.v1';
const EVENT = 'tazor:company';

export function currentCompany(): Company {
  try {
    const id = globalThis.localStorage?.getItem(KEY);
    applyDirectory(cachedDirectory());
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
    void refreshDirectory().then(sync);
    globalThis.addEventListener(EVENT, sync);
    globalThis.addEventListener(DIRECTORY_EVENT, sync);
    globalThis.addEventListener('storage', sync);
    return () => {
      globalThis.removeEventListener(EVENT, sync);
      globalThis.removeEventListener(DIRECTORY_EVENT, sync);
      globalThis.removeEventListener('storage', sync);
    };
  }, []);
  return c;
}
