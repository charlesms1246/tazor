'use client';

import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { config } from '@/lib/config.ts';
import { eventsFor } from '@/lib/events.ts';
import { agoText, roleList, type Person } from '@/lib/people.ts';
import { loadPasskey } from '@/lib/storage.ts';
import { Addr, Pill } from '../_ui/index.tsx';
import { Timeline } from '../_ui/timeline.tsx';
import { BackupSigner } from './backup.tsx';
import { RemovePerson } from './remove.tsx';
import { SoulStatus } from '@/app/_soul/soul-badge.tsx';
import { ensAddressUrl, ensRolesUrl, registryEventsUrl } from './links.ts';

const bitmap = (b: bigint | undefined) => (b === undefined ? 'unreadable' : `0x${b.toString(16)}`);

/** Right-side panel for one person: ENS vs Whitechain roles, WB Soul, links, timeline and access actions. */
export function PersonDrawer({ person, account, ens, registry, onClose }: {
  person: Person; account: Address; ens: string; registry: Address | null; onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isMe, setIsMe] = useState(false);
  const [syncTx, setSyncTx] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const me = loadPasskey()?.approverAccount;
    setIsMe(!!me && me.toLowerCase() === person.address.toLowerCase());
    setSyncTx(eventsFor(person.address).filter((e) => e.kind === 'role-synced' && e.tx).at(-1)?.tx ?? null);
  }, [person.address]);

  const ensRoles = person.ensBits !== undefined ? roleList(person.ensBits) : [];
  const cacheRoles = person.cacheBits !== undefined ? roleList(person.cacheBits) : [];

  return (
    <>
      <div className="drawer-overlay" data-testid="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={person.label} data-testid="person-drawer">
        <div className="drawer-head">
          <div>
            <h2>{person.label}</h2>
            <div style={{ marginTop: 4 }}><Addr value={person.address} href={`${config.explorer}/address/${person.address}`} full /></div>
          </div>
          <button ref={closeRef} className="btn btn-sm btn-ghost" data-testid="drawer-close" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="drawer-body">
          <section className="drawer-section">
            <h3>Roles</h3>
            <div className="row">{ensRoles.length ? ensRoles.map((r) => <Pill key={r}>{r}</Pill>) : <span className="faint">No role on ENS</span>}</div>
          </section>

          <div className="grid-2">
            <div className="well">
              <div className="small faint">ENS (source of truth)</div>
              <div className="row" style={{ marginTop: 6 }}>{ensRoles.length ? ensRoles.join(', ') : 'none'}</div>
              <div className="mono small break" style={{ marginTop: 6 }} data-testid="person-ens-bitmap">{bitmap(person.ensBits)}</div>
              <div className="small faint" style={{ marginTop: 6 }}>Read live from Ethereum Sepolia</div>
            </div>
            <div className="well">
              <div className="small faint">Whitechain role cache</div>
              <div className="row" style={{ marginTop: 6 }}>{cacheRoles.length ? cacheRoles.join(', ') : 'none'}</div>
              <div className="mono small break" style={{ marginTop: 6 }} data-testid="person-cache-bitmap">{bitmap(person.cacheBits)}</div>
              <div className="small faint" style={{ marginTop: 6 }}>
                {person.cachedAt ? <>L1 block {person.cachedAt.toLocaleString('en-US')}{person.cacheAgeSec !== undefined && <> · {agoText(person.cacheAgeSec)}</>}</> : 'Never synced'}
              </div>
            </div>
          </div>

          <section className="drawer-section">
            <h3>WB Soul</h3>
            <SoulStatus address={person.address} />
            <p className="small muted" style={{ marginTop: 8 }}>The mainnet line is WhiteBIT&apos;s real registry, read live; the testnet mirror is simulated. <a href="/docs/wb-soul/">Check any address against the real registry</a>.</p>
          </section>

          <section className="drawer-section">
            <h3>Links</h3>
            <div className="drawer-links">
              <a href={ensAddressUrl(person.address)} target="_blank" rel="noreferrer" data-testid="person-ens-link">This address on the ENS explorer</a>
              <a href={ensRolesUrl(ens)} target="_blank" rel="noreferrer">Roles in {ens}</a>
              {registry && <a href={registryEventsUrl(registry)} target="_blank" rel="noreferrer" data-testid="person-registry-events">Role-change events on Sepolia Etherscan</a>}
              {syncTx && <a href={`${config.explorer}/tx/${syncTx}`} target="_blank" rel="noreferrer">Latest role-cache sync on Whitechain</a>}
            </div>
          </section>

          <section className="drawer-section">
            <h3>Activity</h3>
            <Timeline subject={person.address} testId="drawer-timeline" />
          </section>

          <section className="drawer-section stack">
            <h3>Actions</h3>
            {isMe && <BackupSigner />}
            <RemovePerson initialAccount={account} initialTarget={person.address} />
          </section>
        </div>
      </aside>
    </>
  );
}
