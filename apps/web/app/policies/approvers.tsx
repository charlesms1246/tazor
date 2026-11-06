'use client';

import { useCallback, useEffect, useState } from 'react';
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, size, type Address, type Hex } from 'viem';
import { config } from '@/lib/config.ts';
import { ROLE_AGENT, ROLE_APPROVER, ROLE_TAZOR_ADMIN } from '@/lib/policies.ts';
import { decodeIsRevoked, encodeIsRevokedCall } from '@/lib/revoke.ts';
import { ethCall, rpc } from '@/lib/rpc.ts';

const abi = parseAbi([
  'function getSignerCount() view returns (uint256)',
  'function getSigners(uint64 start, uint64 end) view returns (bytes[])',
  'function rolesOf(address registry, address account) view returns (uint256 roles, uint64 l1Block)',
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function number() view returns (uint64)',
]);
const L1_BLOCK: Address = '0x4200000000000000000000000000000000000015';
const call = <T,>(to: Address, functionName: string, args: readonly unknown[] = [], url?: string) =>
  rpc<Hex>('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, 'latest'], url)
    .then((data) => decodeFunctionResult({ abi, functionName, data } as never) as T);

const roleNames = (r: bigint) => [r & ROLE_APPROVER ? 'approver' : '', r & ROLE_TAZOR_ADMIN ? 'admin' : '', r & ROLE_AGENT ? 'agent' : ''].filter(Boolean).join(', ') || 'none';
const KEY = (account: Address) => `tazor.approvers.${account.toLowerCase()}`;
const loadKnown = (account: Address): Address[] => { try { return JSON.parse(localStorage.getItem(KEY(account)) ?? '[]'); } catch { return []; } };
const saveKnown = (account: Address, list: Address[]) => { try { localStorage.setItem(KEY(account), JSON.stringify(list)); } catch { /* unavailable */ } };

type Row = {
  approver: Address; admin: boolean; revoked: boolean | null; cached: bigint | null; cachedAt: bigint | null; ens: bigint | null;
};

/** Whitechain vs ENS view of a company's approvers; flags a pending ENS mirror and a stale role cache. */
export function ApproversPanel({ account, registry, revocationList }: { account: Address; registry: Address; revocationList: Address | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [known, setKnown] = useState<Address[]>([]);
  const [l1, setL1] = useState<bigint | null>(null);
  const [add, setAdd] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const n = await call<bigint>(account, 'getSignerCount');
      const signers = n > 0n ? await call<Hex[]>(account, 'getSigners', [0n, n]) : [];
      const admins = signers.filter((s) => size(s) === 20).map((s) => getAddress(s));
      const local = loadKnown(account);
      setKnown(local);
      const all = [...new Map([...admins, ...local].map((a) => [a.toLowerCase(), a])).values()];
      setL1(await call<bigint>(L1_BLOCK, 'number').catch(() => null));
      setRows(await Promise.all(all.map(async (approver): Promise<Row> => {
        const revoked = revocationList ? await ethCall(revocationList, encodeIsRevokedCall(account, approver)).then(decodeIsRevoked).catch(() => null) : null;
        const cache = config.roleCache ? await call<readonly [bigint, bigint]>(config.roleCache, 'rolesOf', [registry, approver]).catch(() => null) : null;
        const ens = await call<bigint>(registry, 'roles', [0n, approver], config.sepolia.rpcUrl).catch(() => null);
        return { approver, admin: admins.some((a) => a.toLowerCase() === approver.toLowerCase()), revoked, cached: cache?.[0] ?? null, cachedAt: cache?.[1] ?? null, ens };
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [account, registry, revocationList]);

  useEffect(() => { void load(); }, [load]);

  const onAdd = () => {
    if (!isAddress(add)) return setError('Enter an approver address.');
    const list = [...known.filter((a) => a.toLowerCase() !== add.toLowerCase()), getAddress(add)];
    saveKnown(account, list);
    setAdd('');
    void load();
  };

  return (
    <section>
      <h2>Approvers: Whitechain vs ENS</h2>
      <p>Admins come from the account&apos;s signers; add other approvers you know. ENS roles are read live from Ethereum Sepolia (registry {registry}).</p>
      <table data-testid="approvers">
        <thead><tr><th>Approver</th><th>Whitechain</th><th>Role cache</th><th>ENS now</th><th>Flags</th></tr></thead>
        <tbody>
          {rows?.map((r) => {
            const flags: string[] = [];
            if (r.revoked && r.ens !== null && (r.ens & ROLE_APPROVER) !== 0n) flags.push('Revoked on Whitechain but still listed on ENS (mirror pending)');
            if (r.ens !== null && r.cached !== null && r.ens !== r.cached) flags.push('ENS role changed, cache stale (sync pending)');
            return (
              <tr key={r.approver} data-testid={`approver-${r.approver.toLowerCase()}`}>
                <td>{r.approver}{r.admin ? ' (admin signer)' : ''}</td>
                <td>{r.revoked === null ? 'unknown' : r.revoked ? 'revoked' : 'active'}</td>
                <td>{r.cached === null ? 'unknown' : `${roleNames(r.cached)}${r.cachedAt ? ` (L1 block ${r.cachedAt}${l1 !== null ? `, ${l1 - r.cachedAt} blocks old` : ''})` : ' (never synced)'}`}</td>
                <td>{r.ens === null ? 'unknown' : roleNames(r.ens)}</td>
                <td data-testid="approver-flags" style={{ color: flags.length ? '#b45309' : undefined }}>{flags.join('; ') || 'in sync'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p><label>Approver <input data-testid="approver-add" value={add} onChange={(e) => setAdd(e.target.value)} size={44} /></label>{' '}
        <button data-testid="approver-add-btn" onClick={onAdd}>Track</button>{' '}
        <button data-testid="approvers-refresh" onClick={() => void load()}>Refresh</button></p>
      {error && <p data-testid="approvers-error" style={{ color: 'crimson' }}>{error}</p>}
    </section>
  );
}
