'use client';

import { useEffect, useState } from 'react';
import { DEMO_CHANGED, clearDemo, demoCounts, isDemoLoaded, seedDemo } from '../../lib/demo-seed.ts';
import { DEMO_RUN_DATE } from '../../lib/demo-data.ts';
import './demo.css';

function useLoaded() {
  const [loaded, setLoaded] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setLoaded(isDemoLoaded());
    sync();
    window.addEventListener(DEMO_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(DEMO_CHANGED, sync); window.removeEventListener('storage', sync); };
  }, []);
  return loaded;
}

/**
 * Invoices empty state: load the invoices from our testnet runs onto this device. Invoice contents never go on-chain
 * (only their hash does), so this is the only way to see them here; each one links to its real payment transaction.
 */
export function SampleInvoices() {
  const loaded = useLoaded();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (loaded !== false) return null;
  const n = demoCounts();
  const onLoad = async () => {
    setBusy(true); setError(null);
    try {
      if (!(await seedDemo())) setError('This browser would not save the sample invoices.');
      // every card reads its stores once, so reload to show them everywhere
      else location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="demo-samples" data-testid="inv-samples">
      <button type="button" className="btn btn-sm" onClick={onLoad} disabled={busy} data-testid="inv-load-samples">{busy ? 'Loading…' : 'Load sample invoices from our testnet runs'}</button>
      <span className="small muted">{n.invoices} invoices from our {DEMO_RUN_DATE} runs, each linked to its real payment.</span>
      {error && <span className="small" role="alert" style={{ color: 'var(--negative)' }} data-testid="inv-samples-error">{error}</span>}
    </div>
  );
}

/** Shown under the invoice list while the samples are on this device. */
export function ClearSampleInvoices() {
  const loaded = useLoaded();
  if (!loaded) return null;
  return (
    <p className="small muted demo-samples-clear" data-testid="inv-samples-loaded">
      Includes sample invoices from our {DEMO_RUN_DATE} testnet runs.{' '}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { clearDemo(); location.reload(); }} data-testid="inv-clear-samples">Remove samples</button>
    </p>
  );
}
