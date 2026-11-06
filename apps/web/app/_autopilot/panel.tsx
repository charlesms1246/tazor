'use client';

import { useEffect, useRef, useState } from 'react';
import { STORY } from './story.ts';
import { appliesTo, type RunState } from './engine.ts';
import { AUTOPILOT_EVENT, explorerTx, findTestId, getRunner } from './browser.ts';
import './autopilot.css';

/** Subscribes to the shared runner. */
export function useAutopilot(): RunState | null {
  const [s, setS] = useState<RunState | null>(null);
  useEffect(() => {
    const r = getRunner();
    const sync = () => setS(r.state() ? { ...r.state()! } : null);
    sync();
    addEventListener(AUTOPILOT_EVENT, sync);
    return () => removeEventListener(AUTOPILOT_EVENT, sync);
  }, []);
  return s;
}

/** A ring around the element the Autopilot is acting on. It never blocks the page. */
function Ring({ testid, tap }: { testid?: string; tap: boolean }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!testid) { setRect(null); return; }
    let raf = 0;
    const tick = () => { const el = findTestId(testid); setRect(el ? el.getBoundingClientRect() : null); raf = requestAnimationFrame(tick); };
    findTestId(testid)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tick();
    return () => cancelAnimationFrame(raf);
  }, [testid]);
  if (!rect || !testid) return null;
  return (
    <div className="ap-ring" data-tap={tap ? 'true' : 'false'} aria-hidden="true"
      style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}>
      {tap && <span className="ap-ring-label">Tap here</span>}
    </div>
  );
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The docked Autopilot panel (bottom sheet on a phone). Mount once in the app shell. */
export function AutopilotPanel() {
  const s = useAutopilot();
  const [open, setOpen] = useState(true);
  const logRef = useRef<HTMLOListElement>(null);

  // pick up a run that was in progress before this page loaded
  useEffect(() => { getRunner().resume(); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [s?.log.length]);

  if (!s) return null;
  const r = getRunner();
  const steps = STORY.filter((x) => appliesTo(x, s.mode));
  const step = STORY[s.step];
  const index = step ? steps.indexOf(step) : steps.length;
  const tapping = s.status === 'waiting-user';
  const lines = s.log.slice(-40);

  return (
    <>
      <Ring testid={s.highlight} tap={tapping} />
      <aside className="ap-panel" data-open={open ? 'true' : 'false'} data-status={s.status} data-testid="autopilot-panel" aria-label="Autopilot" aria-live="polite">
        <header className="ap-head">
          <button type="button" className="ap-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="autopilot-toggle">
            <span className="ap-badge">Autopilot</span>
            <span className="ap-count" data-testid="autopilot-progress">{Math.min(index + 1, steps.length)} / {steps.length}</span>
            <span className="ap-mode">{s.mode === 'guest' ? 'Try it yourself' : 'Presenter'}</span>
          </button>
          <div className="ap-bar" aria-hidden="true"><span style={{ width: `${(s.done.length / steps.length) * 100}%` }} /></div>
        </header>

        {open && (
          <div className="ap-body">
            {step ? (
              <div className="ap-step" data-testid="autopilot-step">
                <h2>{step.title}</h2>
                <p className="ap-why">{step.why}</p>
              </div>
            ) : <div className="ap-step"><h2>Done</h2><p className="ap-why">Every step ran on the real pages.</p></div>}

            {tapping && s.prompt && (
              <div className="ap-callout" data-testid="autopilot-your-turn">
                <b>{s.prompt}</b>
                {s.link
                  ? <a className="btn btn-primary" href={s.link} target="_blank" rel="noreferrer" onClick={() => r.ack()} data-testid="autopilot-open-tab">Open {new URL(s.link).host}</a>
                  : <span className="ap-callout-sub">The Autopilot continues as soon as the page reaches the next state.</span>}
              </div>
            )}
            {s.status === 'failed' && <div className="ap-error" role="alert" data-testid="autopilot-error">{s.error}</div>}

            <ol className="ap-log" ref={logRef} data-testid="autopilot-log">
              {lines.map((l, i) => (
                <li key={`${l.at}-${i}`} data-kind={l.kind}>
                  <span className="ap-time">{time(l.at)}</span>
                  <span className="ap-text">
                    {l.kind === 'sim' && <span className="ap-sim">simulated counterparty</span>}
                    {l.text}
                    {l.tx && <> <a href={explorerTx(l.chain, l.tx)} target="_blank" rel="noreferrer" className="mono" data-testid="autopilot-tx">{l.tx.slice(0, 10)}…</a></>}
                  </span>
                </li>
              ))}
            </ol>

            <div className="ap-controls">
              {s.status === 'paused'
                ? <button type="button" className="btn btn-sm btn-primary" onClick={() => r.play()} data-testid="autopilot-play">Resume</button>
                : <button type="button" className="btn btn-sm" onClick={() => r.pause()} disabled={s.status === 'done' || s.status === 'failed'} data-testid="autopilot-pause">Pause</button>}
              <button type="button" className="btn btn-sm" onClick={() => r.skip()} disabled={s.status === 'done'} data-testid="autopilot-skip">Skip</button>
              <button type="button" className="btn btn-sm" onClick={() => r.retry()} disabled={s.status === 'done'} data-testid="autopilot-retry">Retry</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => r.stop()} data-testid="autopilot-stop">{s.status === 'done' ? 'Close' : 'Stop'}</button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
