'use client';

import { useEffect, useState } from 'react';
import { loadPasskey } from '@/lib/storage.ts';
import { STORY } from '../_autopilot/story.ts';
import { appliesTo, type Mode } from '../_autopilot/engine.ts';
import { getRunner } from '../_autopilot/browser.ts';
import { useAutopilot } from '../_autopilot/panel.tsx';
import { Card, Notice, PageHeader } from '../_ui/index.tsx';
import './landing.css';

export default function AutopilotPage() {
  const s = useAutopilot();
  const [mode, setMode] = useState<Mode>('presenter');
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    const k = !!loadPasskey();
    setHasKey(k);
    if (!k) setMode('guest');
  }, []);

  const running = !!s && s.status !== 'done' && s.status !== 'failed';
  const steps = STORY.filter((x) => appliesTo(x, s?.mode ?? mode));
  const onStart = () => getRunner().start(mode);

  return (
    <div className="page autopilot-page">
      <PageHeader title="Autopilot" subtitle="Every feature, end to end, on the real pages and real testnet transactions. It pauses only where a browser needs your tap." />

      <Card className="ap-hero">
        <div className="ap-modes" role="radiogroup" aria-label="Mode">
          <button type="button" role="radio" aria-checked={mode === 'presenter'} className="ap-mode-btn" onClick={() => setMode('presenter')} disabled={running} data-testid="autopilot-mode-presenter">
            <b>Presenter</b><span>Uses the passkey already on this device{hasKey === false ? ' (none on this device yet)' : ''}</span>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'guest'} className="ap-mode-btn" onClick={() => setMode('guest')} disabled={running} data-testid="autopilot-mode-guest">
            <b>Try it yourself</b><span>Create a new passkey on this device first</span>
          </button>
        </div>
        <button type="button" className="btn btn-primary ap-start" onClick={onStart} disabled={running} data-testid="autopilot-start">
          {running ? 'Autopilot is running' : s?.status === 'done' ? 'Run it again' : 'Start Autopilot'}
        </button>
        {mode === 'presenter' && hasKey === false && <Notice tone="warning">No passkey on this device yet. Choose Try it yourself to create one.</Notice>}
        <p className="small muted">Both modes run on a sandbox company: your passkey is added as its approver, so the demo never touches a real company. Other parties (the second approver, Ravi, the financier, the supplier collecting) are simulated counterparties and are labelled as such. The Ethereum fallback is signed by your browser wallet on Sepolia. Testnet only.</p>
      </Card>

      <Card title="The story" flush>
        <ol className="ap-story" data-testid="autopilot-story">
          {steps.map((x, i) => {
            const done = !!s?.done.includes(x.id);
            const current = !!s && STORY[s.step]?.id === x.id && s.status !== 'done';
            return (
              <li key={x.id} data-done={done ? 'true' : 'false'} data-current={current ? 'true' : 'false'} data-testid="autopilot-story-step">
                <span className="ap-story-n" aria-hidden="true">{done ? '✓' : i + 1}</span>
                <span><b>{x.title}</b><span className="cell-sub">{x.why}</span></span>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
