import { useEffect, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import {
  DIRECTORY_EVENT, cachedDirectory, directoryStatus, refreshDirectory, retryDirectory, type Directory, type DirectoryStatus,
} from './ens-directory.ts';

export type Company = {
  /** ENS label under taz0r.eth (e.g. 'acme', 'sandbox'). Every company comes from ENS; nothing is hard-coded. */
  id: string;
  ens: string;
  name: string;
  account: Address;
  role: string;
  /** Earlier accounts of the same company, from its `tazor.aliases` text record. */
  aliases: Address[];
  /** 'ready' for a company read from ENS; a blank placeholder is 'loading' or 'error' (ENS unreachable). */
  status?: DirectoryStatus;
};

/** What pages get before ENS answers (or when it can't be read): blank, never a made-up company. */
export const PLACEHOLDER = (status: DirectoryStatus): Company =>
  ({ id: '', ens: '', name: '', account: zeroAddress, role: '', aliases: [], status });

/** Companies registered under taz0r.eth that have a Whitechain account (ENSIP-11). Empty until ENS answers; updated in place. */
export const COMPANIES: Company[] = [];

/** Companies from an ENS directory: those with a Whitechain account, sorted by label. */
export function companiesFromDirectory(d: Directory | null): Company[] {
  if (!d) return [];
  return d.companies
    .filter((c) => c.account)
    .map((c): Company => ({ id: c.label, ens: c.ens, name: c.name, account: c.account!, role: c.role ?? 'Company', aliases: c.aliases ?? [], status: 'ready' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function applyDirectory(d: Directory | null): void {
  const next = companiesFromDirectory(d);
  const same = next.length === COMPANIES.length && next.every((c, i) => JSON.stringify(c) === JSON.stringify(COMPANIES[i]));
  if (!same) COMPANIES.splice(0, COMPANIES.length, ...next);
}

/** ENS directory state for skeletons and the "Couldn't read ENS" notice; `retry` forces a fresh read. */
export function useDirectoryStatus(): { status: DirectoryStatus; retry: () => void } {
  const [status, setStatus] = useState<DirectoryStatus>('loading');
  useEffect(() => {
    const sync = () => setStatus(directoryStatus());
    sync();
    void refreshDirectory().then(sync);
    globalThis.addEventListener(DIRECTORY_EVENT, sync);
    return () => globalThis.removeEventListener(DIRECTORY_EVENT, sync);
  }, []);
  return { status, retry: () => { void retryDirectory(); } };
}

/** All companies from ENS (empty while loading or if ENS is unreachable). */
export function useCompanies(): Company[] {
  const [list, setList] = useState<Company[]>([]);
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

/** The selected company (stored label), else the first from ENS, else a blank placeholder with the directory status. */
export function currentCompany(): Company {
  try {
    const id = globalThis.localStorage?.getItem(KEY);
    applyDirectory(cachedDirectory());
    return COMPANIES.find((c) => c.id === id) ?? COMPANIES[0] ?? PLACEHOLDER(directoryStatus());
  } catch {
    return COMPANIES[0] ?? PLACEHOLDER('loading');
  }
}

export function setCompany(id: string): void {
  try { globalThis.localStorage?.setItem(KEY, id); } catch { /* storage unavailable */ }
  globalThis.dispatchEvent?.(new Event(EVENT));
}

export const isCompanyAccount = (c: Company, a: string): boolean =>
  c.status !== 'loading' && c.status !== 'error' && [c.account, ...c.aliases].some((x) => x.toLowerCase() === a.toLowerCase());

let appliedAt = 0;
/** COMPANIES, refreshed from the cached ENS directory at most once a second (for code outside React hooks). */
export function companies(): Company[] {
  if (Date.now() - appliedAt > 1000) { appliedAt = Date.now(); applyDirectory(cachedDirectory()); }
  return COMPANIES;
}

export const companyByAccount = (a: string): Company | null => companies().find((c) => isCompanyAccount(c, a)) ?? null;

/** The selected company; a blank 'loading' placeholder on first render (static HTML names no company), then ENS. */
export function useCompany(): Company {
  const [c, setC] = useState<Company>(PLACEHOLDER('loading'));
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
