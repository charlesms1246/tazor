'use client';

import { useEffect, useState } from 'react';
import { config } from '@/lib/config.ts';
import { eventsFor, EVENTS_CHANGED, type TimelineEvent } from '@/lib/events.ts';

const txUrl = (e: TimelineEvent) => (e.chain === 'sepolia' ? `${config.sepolia.explorer}/tx/${e.tx}` : `${config.explorer}/tx/${e.tx}`);
const TONE: Partial<Record<TimelineEvent['kind'], string>> = {
  paid: 'done', 'fallback-delivered': 'done', collected: 'done', settled: 'done', 'role-synced': 'done',
  failed: 'bad', 'supplier-unverified': 'warn', 'role-revoked': 'bad', 'mandate-cancelled': 'warn',
};
const time = (ms: number) => new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A vertical timeline of what happened to one subject (an invoice hash, a mandate id, an address). */
export function Timeline({ subject, events: given, pending, testId = 'timeline' }: {
  subject?: string; events?: TimelineEvent[]; pending?: string[]; testId?: string;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>(given ?? []);
  useEffect(() => {
    if (given) { setEvents(given); return; }
    if (!subject) return;
    const sync = () => setEvents(eventsFor(subject));
    sync();
    globalThis.addEventListener(EVENTS_CHANGED, sync);
    return () => globalThis.removeEventListener(EVENTS_CHANGED, sync);
  }, [subject, given]);

  if (events.length === 0 && !pending?.length) return <p className="muted small" data-testid={`${testId}-empty`}>Nothing has happened to this yet.</p>;
  return (
    <ol className="timeline" data-testid={testId}>
      {events.map((e, i) => (
        <li key={`${e.kind}-${e.at}-${i}`} data-kind={e.kind} data-tone={TONE[e.kind] ?? 'ok'}>
          <span className="tl-dot" aria-hidden="true" />
          <div className="tl-body">
            <div className="tl-title">{e.title}</div>
            <div className="tl-meta">
              {time(e.at)}
              {e.actor && <> · {e.actor}</>}
              {e.detail && <> · {e.detail}</>}
              {e.tx && <> · <a href={txUrl(e)} target="_blank" rel="noreferrer">{e.chain === 'sepolia' ? 'Ethereum tx' : 'Whitechain tx'}</a></>}
            </div>
          </div>
        </li>
      ))}
      {pending?.map((p) => (
        <li key={p} data-tone="pending">
          <span className="tl-dot" aria-hidden="true" />
          <div className="tl-body"><div className="tl-title muted">{p}</div></div>
        </li>
      ))}
    </ol>
  );
}
