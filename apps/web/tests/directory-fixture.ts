// Test-only ENS directory: what lib/ens-directory.ts caches after reading the taz0r.eth registry and records.
// The app itself has no company or people data; specs and unit tests seed this instead of hitting ENS.
import type { Directory } from '../lib/ens-directory.ts';

export const DIRECTORY_KEY = 'tazor.ens-directory.v2';
export const ACME_REGISTRY = '0x331bDB575A72Fb3dd8a6C85b6C043A753340Fbf1';
export const BLUEJAY_REGISTRY = '0x2A582b9cFD4C20921C467512B7ebA41204d9a16b';
const OWNER = '0xce4389ACb79463062c362fACB8CB04513fA3D8D8';
const ROLE_BITS = { APPROVER: 64, TAZOR_ADMIN: 68, AGENT: 72 };

export const FIXTURE_DIRECTORY: Directory = {
  source: 'ens',
  fetchedAt: 0,
  companies: [
    {
      label: 'acme', ens: 'acme.taz0r.eth', registry: ACME_REGISTRY, owner: OWNER, expiry: 0, name: 'Acme Industries', role: 'Buyer',
      account: '0xb99A12652BEe98429ae31EA0529A0b63f1073721',
      aliases: ['0xEA5A4Be313E05Eb254900b6aDBb7D655c55242F6', '0x18d15B034C645dbbFCb9c68238A14D059f632513'], roleBits: ROLE_BITS, fallback: [],
    },
    {
      label: 'bluejay', ens: 'bluejay.taz0r.eth', registry: BLUEJAY_REGISTRY, owner: OWNER, expiry: 0, name: 'Bluejay Logistics', role: 'Supplier',
      account: '0xc1dce946D192e344251972470237F1471C93876c', aliases: [], roleBits: ROLE_BITS, fallback: [],
    },
  ],
  members: {
    acme: [
      { address: '0x00aBed5bDddf794c415eE746d3E4De5332cC5450', label: 'Priya (Finance)', ens: 'priya.acme.taz0r.eth', source: 'ens-text' },
      { address: '0x20BA842dc15CBcF4e02d8Ce77e07391a949bB967', label: 'CFO (Finance)', ens: 'cfo.acme.taz0r.eth', source: 'ens-text' },
      { address: '0xeD7335f5aD5E60691B0d88A4b8921a65c7e4c3Cb', label: 'Ravi (Operations)', ens: 'ravi.acme.taz0r.eth', source: 'ens-text' },
      { address: '0x03C291d446b870e0B8F128681937a9eCEDa97763', label: 'Meera (EIP-7702 wallet)', ens: 'meera.acme.taz0r.eth', source: 'ens-text' },
    ],
    bluejay: [],
  },
};

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v);
/** The cached JSON as lib/ens-directory.ts stores it, fresh as of `now`. */
export const directoryJson = (d: Directory = FIXTURE_DIRECTORY, now = Date.now()) => JSON.stringify({ ...d, fetchedAt: now }, replacer);

/** Node tests: put the fixture in the in-memory localStorage shim. */
export function seedDirectory(d: Directory = FIXTURE_DIRECTORY) {
  (globalThis as { localStorage?: Storage }).localStorage?.setItem(DIRECTORY_KEY, directoryJson(d));
}

/** Playwright: seed the cache before any page script runs (fresh, so the app doesn't refetch from ENS). */
export async function mockDirectory(page: { addInitScript: (fn: (a: [string, string]) => void, arg: [string, string]) => Promise<unknown> }, d: Directory = FIXTURE_DIRECTORY) {
  const json = directoryJson(d, 0);
  await page.addInitScript(([k, v]) => {
    const o = JSON.parse(v);
    o.fetchedAt = Date.now();
    localStorage.setItem(k, JSON.stringify(o));
  }, [DIRECTORY_KEY, json]);
}

/** Fresh forever (year 2100), so specs never refetch ENS: the Playwright storageState in tests/ens-directory.state.json. */
export const STATE_FETCHED_AT = 4_102_444_800_000;
export const storageState = (origin = 'http://localhost:4173') => ({
  cookies: [],
  origins: [{ origin, localStorage: [{ name: DIRECTORY_KEY, value: directoryJson(FIXTURE_DIRECTORY, STATE_FETCHED_AT) }] }],
});
