'use client';

import { useEffect, useState } from 'react';
import { isRelayerSimulatedOff, RELAYER_OFF_EVENT, restoreRelayer, simulateRelayerDown } from '@/lib/relayer-off.ts';

function useRelayerOff(): boolean | null {
  const [off, setOff] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setOff(isRelayerSimulatedOff());
    sync();
    addEventListener(RELAYER_OFF_EVENT, sync);
    addEventListener('storage', sync);
    return () => { removeEventListener(RELAYER_OFF_EVENT, sync); removeEventListener('storage', sync); };
  }, []);
  return off;
}

/** Big banner while the relayer is switched off for a demo. Mount once in the shell to show it on every page. */
export function RelayerOffBanner() {
  const off = useRelayerOff();
  if (!off) return null;
  return (
    <div className="relayer-off-banner" role="status" data-testid="relayer-off-banner">
      <span><b>Relayer off (simulated).</b> This device can&apos;t reach Tazor&apos;s servers. Payments still go through, via Ethereum.</span>
      <button type="button" className="btn btn-sm" onClick={restoreRelayer} data-testid="relayer-simulate-on">Turn back on</button>
    </div>
  );
}

/** One-tap switch for the "our servers are down" demo. */
export function RelayerOffSwitch({ onChange }: { onChange?: () => void }) {
  const off = useRelayerOff();
  if (off === null) return null;
  return (
    <div className="relayer-off-switch">
      <div>
        <b>Simulate relayer down</b>
        <p className="small muted">Points this device at a relayer address that never answers, exactly as if our servers were down. Turn it back on any time.</p>
      </div>
      {off
        ? <button type="button" className="btn btn-primary" onClick={() => { restoreRelayer(); onChange?.(); }} data-testid="relayer-simulate-on">Turn back on</button>
        : <button type="button" className="btn btn-danger" onClick={() => { simulateRelayerDown(); onChange?.(); }} data-testid="relayer-simulate-off">Simulate relayer down</button>}
    </div>
  );
}
