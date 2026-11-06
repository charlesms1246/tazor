'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { L1_BLOCK, adminSigners, approverFlags, readApprovers, roleNames, uniqueAddresses, type ApproverView } from '@/lib/people.ts';
import { rpc } from '@/lib/rpc.ts';
import { Card, Field, Notice, Pill } from '../_ui/index.tsx';

const KEY = (account: Address) => `tazor.approvers.${account.toLowerCase()}`;
const loadKnown = (account: Address): Address[] => { try { return JSON.parse(localStorage.getItem(KEY(account)) ?? '[]'); } catch { return []; } };
const saveKnown = (account: Address, list: Address[]) => { try { localStorage.setItem(KEY(account), JSON.stringify(list)); } catch { /* unavailable */ } };
const l1Number = () => rpc<string>('eth_call', [{ to: L1_BLOCK, data: '0x8381f58a' }, 'latest']).then((h) => BigInt(h));

type Row = ApproverView;

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
      const admins = await adminSigners(account);
      const local = loadKnown(account);
      setKnown(local);
      setL1(await l1Number().catch(() => null));
      setRows(await readApprovers(account, registry, revocationList, uniqueAddresses([...admins, ...local]), admins));
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
    <Card
      title="Approvers"
      subtitle={<>Whitechain vs ENS. Admins come from the account&apos;s signers; ENS roles are read live from Ethereum Sepolia (registry <span className="mono break">{registry}</span>).</>}
      actions={<button className="btn btn-sm" data-testid="approvers-refresh" onClick={() => void load()}>Refresh</button>}
      flush
    >
      <div className="table-wrap"><table className="table table-stack" data-testid="approvers">
        <thead><tr><th>Approver</th><th>Whitechain</th><th>Role cache</th><th>ENS now</th><th>Flags</th></tr></thead>
        <tbody>
          {rows?.map((r) => {
            const flags = approverFlags(r);
            return (
              <tr key={r.approver} data-testid={`approver-${r.approver.toLowerCase()}`}>
                <td><span className="mono break">{r.approver}</span>{r.admin && <span className="cell-sub"> (admin signer)</span>}</td>
                <td>{r.revoked === null ? <Pill>unknown</Pill> : r.revoked ? <Pill tone="negative">revoked</Pill> : <Pill tone="positive">active</Pill>}</td>
                <td>{r.cached === null ? <span className="faint">unknown</span> : <>{roleNames(r.cached)}<span className="cell-sub">{r.cachedAt ? ` (L1 block ${r.cachedAt}${l1 !== null ? `, ${l1 - r.cachedAt} blocks old` : ''})` : ' (never synced)'}</span></>}</td>
                <td>{r.ens === null ? <span className="faint">unknown</span> : roleNames(r.ens)}</td>
                <td data-testid="approver-flags">{flags.length
                  ? <span className="pill pill-warning" style={{ whiteSpace: 'normal', height: 'auto', padding: '4px 9px', lineHeight: '16px' }}>{flags.join('; ')}</span>
                  : <Pill tone="positive">in sync</Pill>}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {rows !== null && rows.length === 0 && <div style={{ padding: '0 24px 16px' }}><div className="empty">No approvers found for this account yet. Track one below.</div></div>}
      <div className="stack" style={{ padding: '16px 24px 24px' }}>
        <Field label="Track another approver">
          <div className="input-group">
            <input className="input mono" data-testid="approver-add" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="0x…" />
            <button className="btn" data-testid="approver-add-btn" onClick={onAdd}>Track</button>
          </div>
        </Field>
        {error && <Notice tone="negative"><span data-testid="approvers-error">{error}</span></Notice>}
      </div>
    </Card>
  );
}
