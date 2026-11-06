'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { isAddress } from 'viem';
import { ago, mainnetSoulStats, mainnetTxUrl, type SoulStats } from '../../lib/soul-mainnet.ts';
import { SoulStatus } from './soul-badge.tsx';
import './soul.css';

/** A verified address on mainnet (soul 9531), used as the example. */
const EXAMPLE = '0x0c65bb4ea28200a498e857c011a7ac9f37109729';

/** Check any address against the real WB Soul registry on Whitechain mainnet. */
export function SoulLookup() {
  const [text, setText] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [stats, setStats] = useState<SoulStats | null>(null);
  const bad = text.trim() !== '' && !isAddress(text.trim(), { strict: false });

  useEffect(() => { let live = true; mainnetSoulStats().then((s) => { if (live) setStats(s); }); return () => { live = false; }; }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const a = text.trim();
    if (isAddress(a, { strict: false })) setAddress(a);
  };

  return (
    <section className="card soul-lookup" data-testid="soul-lookup">
      <div className="card-head">
        <div>
          <h2>Check any address</h2>
          <p>WB Soul is WhiteBIT&apos;s on-chain identity. Payments on testnet use a labelled mirror; this reads the real registry on Whitechain mainnet.</p>
        </div>
      </div>
      <form className="soul-form" onSubmit={onSubmit}>
        <input
          className="input mono"
          data-testid="soul-lookup-input"
          aria-label="Whitechain address"
          aria-invalid={bad}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || bad} data-testid="soul-lookup-submit">Check</button>
      </form>
      <p className="small muted soul-hint">
        {bad ? 'That is not a Whitechain address (0x followed by 40 hex characters).' : (
          <>Try a verified example: <button type="button" className="soul-example mono" onClick={() => { setText(EXAMPLE); setAddress(EXAMPLE); }}>{EXAMPLE.slice(0, 10)}…{EXAMPLE.slice(-4)}</button></>
        )}
      </p>
      {address && <SoulStatus key={address.toLowerCase()} address={address} />}
      <p className="small muted soul-stats" data-testid="soul-stats">
        {!stats ? 'Reading the mainnet registry…'
          : stats.error ? <>Could not reach the mainnet explorer ({stats.error}).</>
          : stats.assigned === 0 ? <>No recent address assignments in the <a href={stats.link} target="_blank" rel="noreferrer">registry logs</a>.</>
          : <>
              WB Soul is live on mainnet: {stats.assigned} address assignment{stats.assigned === 1 ? '' : 's'} in the latest page of <a href={stats.link} target="_blank" rel="noreferrer">registry logs</a>
              {stats.latestAt !== null && <>, newest {stats.latestTx ? <a href={mainnetTxUrl(stats.latestTx)} target="_blank" rel="noreferrer">{ago(stats.latestAt)}</a> : ago(stats.latestAt)}</>}.
            </>}
      </p>
    </section>
  );
}
