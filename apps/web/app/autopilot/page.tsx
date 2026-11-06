'use client';

import { useEffect, useState } from 'react';
import { loadPasskey } from '@/lib/storage.ts';
import { STORY } from '../_autopilot/story.ts';
import { stepApplies, type Mode } from '../_autopilot/engine.ts';
import { getRunner } from '../_autopilot/browser.ts';
import { useAutopilot } from '../_autopilot/panel.tsx';
import { Card, Notice, PageHeader } from '../_ui/index.tsx';
import './landing.css';

export default function AutopilotPage() {
  const s = useAutopilot();
  const [mode, setMode] = useState<Exclude<Mode, 'story'>>('presenter');
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    const k = !!loadPasskey();
    setHasKey(k);
    if (!k) setMode('guest');
  }, []);

  const running = !!s && s.status !== 'done' && s.status !== 'failed';
  const tourMode: Mode = s && s.mode !== 'story' ? s.mode : mode;
  const steps = STORY.filter((x) => stepApplies(x, tourMode));
  const storySteps = STORY.filter((x) => stepApplies(x, 'story'));
  const onStart = () => getRunner().start(mode);
  const onStory = () => getRunner().start('story');
  const storyRunning = running && s?.mode === 'story';
  const mark = (id: string) => ({ done: !!s?.done.includes(id), current: !!s && STORY[s.step]?.id === id && s.status !== 'done' });

  return (
    <div className="page autopilot-page">
      <PageHeader title="Autopilot" subtitle="Tazor's story, played on the real pages with real testnet transactions." />

      <Card className="ap-hero" testId="autopilot-featured">
        <div className="ap-featured-head">
          <h2 className="ap-featured-title">The story <span className="muted">(2 min)</span></h2>
          <p className="muted" style={{ margin: 0 }}>A customer pays without gas, the merchant refunds part of it, and the accountant gets the export.</p>
        </div>
        <ol className="ap-story ap-story-short" data-testid="autopilot-story-short">
          {storySteps.map((x, i) => {
            const m = mark(x.id);
            return (
              <li key={x.id} data-done={m.done && s?.mode === 'story' ? 'true' : 'false'} data-current={m.current ? 'true' : 'false'} data-testid="autopilot-story-short-step">
                <span className="ap-story-n" aria-hidden="true">{m.done && s?.mode === 'story' ? '✓' : i + 1}</span>
                <span><b>{x.title}</b><span className="cell-sub">{x.why}</span></span>
              </li>
            );
          })}
        </ol>
        <button type="button" className="btn btn-primary ap-start" onClick={onStory} disabled={running} data-testid="autopilot-start-story">
          {storyRunning ? 'The story is playing' : s?.mode === 'story' && s.status === 'done' ? 'Play it again' : 'Play the story'}
        </button>
        <p className="small muted" style={{ margin: 0 }}>No passkey needed. The customer is simulated on testnet. If this browser has a wallet, you are the merchant and sign the refund; otherwise the sandbox merchant does.</p>
      </Card>

      <h2 className="ap-more-h" data-testid="autopilot-more">More: the full tour</h2>
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
          {running && !storyRunning ? 'Autopilot is running' : s?.status === 'done' && s.mode !== 'story' ? 'Run it again' : 'Start the full tour'}
        </button>
        {mode === 'presenter' && hasKey === false && <Notice tone="warning">No passkey on this device yet. Choose Try it yourself to create one.</Notice>}
        <p className="small muted">Both modes run on a sandbox company: your passkey is added as its approver, so the demo never touches a real company. Other parties (the second approver, Ravi, the supplier collecting, the customers and the AI agent) are simulated counterparties and are labelled as such. The Ethereum fallback is signed by your browser wallet on Sepolia. Testnet only.</p>
      </Card>

      <Card title="Every chapter" flush>
        <ol className="ap-story" data-testid="autopilot-story">
          {steps.map((x, i) => {
            const { done, current } = mark(x.id);
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
