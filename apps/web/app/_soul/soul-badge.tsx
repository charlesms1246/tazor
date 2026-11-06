'use client';

import { useEffect, useState } from 'react';
import { isAddress, getAddress, type Address } from 'viem';
import { Pill } from '../_ui/index.tsx';
import { config } from '../../lib/config.ts';
import { verifiedSoulOf } from '../../lib/soul.ts';
import { mainnetAddressUrl, readMainnetSoul, type MainnetSoul } from '../../lib/soul-mainnet.ts';
import './soul.css';

type Mirror = { state: 'loading' } | { state: 'done'; soulId: bigint | null } | { state: 'error' };

// One live read per address per minute, shared by every badge on the page.
const cache = new Map<string, { at: number; p: Promise<MainnetSoul> }>();
function mainnet(a: string): Promise<MainnetSoul> {
  const k = a.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = readMainnetSoul(a);
  cache.set(k, { at: Date.now(), p });
  p.then((r) => { if (r.error) cache.delete(k); });
  return p;
}

/** Real WB Soul on Whitechain mainnet, read live, and (optionally) the simulated testnet mirror, on two labelled lines. */
export function SoulStatus({ address, mirror = true }: { address: string; mirror?: boolean }) {
  const valid = isAddress(address, { strict: false });
  const addr = valid ? getAddress(address) : null;
  const [main, setMain] = useState<MainnetSoul | null>(null);
  const [mir, setMir] = useState<Mirror>({ state: 'loading' });

  useEffect(() => {
    if (!addr) return;
    let live = true;
    setMain(null);
    mainnet(addr).then((r) => { if (live) setMain(r); });
    const mirrorAt = config.wbSoulMirror;
    if (mirror && !mirrorAt) setMir({ state: 'error' });
    if (mirror && mirrorAt) {
      setMir({ state: 'loading' });
      verifiedSoulOf(mirrorAt, addr as Address)
        .then((soulId) => { if (live) setMir({ state: 'done', soulId }); })
        .catch(() => { if (live) setMir({ state: 'error' }); });
    }
    return () => { live = false; };
  }, [addr, mirror]);

  if (!addr) return <div className="soul-status" data-testid="soul-status"><Pill>Not an address</Pill></div>;

  const mainPill = !main
    ? <Pill testId="soul-mainnet-pill">Checking mainnet…</Pill>
    : main.verified === null
      ? <Pill testId="soul-mainnet-pill">Mainnet unreachable</Pill>
      : main.soulId === null
        ? <Pill testId="soul-mainnet-pill">No Soul on mainnet</Pill>
        : main.verified
          ? <Pill tone="positive" dot testId="soul-mainnet-pill">Verified · Soul #{main.soulId.toString()}</Pill>
          : <Pill tone="warning" testId="soul-mainnet-pill">Soul #{main.soulId.toString()} · not verified</Pill>;

  const mirrorPill = mir.state === 'loading'
    ? <Pill testId="soul-mirror-pill">Checking…</Pill>
    : mir.state === 'error'
      ? <Pill testId="soul-mirror-pill">Mirror unreachable</Pill>
      : mir.soulId !== null
        ? <Pill tone="info" testId="soul-mirror-pill">Verified (simulated)</Pill>
        : <Pill testId="soul-mirror-pill">Not in the mirror</Pill>;

  return (
    <div className="soul-status" data-testid="soul-status" data-mainnet={main ? (main.verified ? 'verified' : main.verified === null ? 'unknown' : main.soulId === null ? 'none' : 'unverified') : 'loading'}>
      <div className="soul-line">
        <a className="soul-label" href={mainnetAddressUrl(addr)} target="_blank" rel="noreferrer" data-testid="soul-mainnet-link">WB Soul (mainnet)</a>
        {mainPill}
        {main?.verified && <span className="soul-live" title="Read live from Whitechain mainnet">live</span>}
      </div>
      {mirror && (
        <div className="soul-line">
          <span className="soul-label">Testnet mirror</span>
          {mirrorPill}
        </div>
      )}
    </div>
  );
}
