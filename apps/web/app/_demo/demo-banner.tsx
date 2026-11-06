'use client';

import { useEffect, useState } from 'react';
import { DEMO_CHANGED, clearDemo, demoCounts, isDemoLoaded, seedDemo } from '../../lib/demo-seed.ts';
import { DEMO_RUN_DATE } from '../../lib/demo-data.ts';
import './demo.css';

/** Loads or clears the live testnet history on this device. */
export function DemoControls() {
  const [loaded, setLoaded] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = demoCounts();

  useEffect(() => {
    const sync = () => setLoaded(isDemoLoaded());
    sync();
    window.addEventListener(DEMO_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(DEMO_CHANGED, sync); window.removeEventListener('storage', sync); };
  }, []);

  const onLoad = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!(await seedDemo())) setError('This browser would not save the demo data.');
      // Every card on the page reads its stores once, so reload to show the history everywhere.
      else location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setLoaded(isDemoLoaded());
    }
  };
  const onClear = () => { clearDemo(); setLoaded(isDemoLoaded()); location.reload(); };

  if (loaded === null) return null;

  return (
    <section className="card demo-controls" data-testid="demo-controls" data-loaded={loaded ? 'true' : 'false'}>
      <div className="card-head">
        <div>
          <h2>{loaded ? 'Demo data loaded' : 'Live testnet history'}</h2>
          <p>
            {loaded
              ? `Records from our ${DEMO_RUN_DATE} testnet runs are on this device, each linked to its real transaction. Clearing removes only those records.`
              : `Show our live testnet history: ${n.invoices} invoices, ${n.payments} payments and the Ethereum fallback, all with real transactions.`}
          </p>
        </div>
        <div className="row">
          {loaded
            ? <button type="button" className="btn btn-sm" onClick={onClear} data-testid="demo-clear">Clear demo data</button>
            : <button type="button" className="btn btn-sm btn-primary" onClick={onLoad} disabled={busy} data-testid="demo-load">{busy ? 'Loading…' : 'Load demo data'}</button>}
        </div>
      </div>
      {error && <p className="small" role="alert" style={{ color: 'var(--negative)' }} data-testid="demo-error">{error}</p>}
    </section>
  );
}
