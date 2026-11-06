'use client';

import type { Address } from 'viem';
import type { TimelineEvent } from '@/lib/events.ts';
import { pendingSteps, type Step } from '@/lib/story.ts';
import { Timeline } from '../_ui/timeline.tsx';

/** A Timeline of merged device + chain events, with one quiet line about the chain read. */
export function HistoryTimeline({ events, loading, error, steps, testId }: {
  events: TimelineEvent[]; loading: boolean; error: string | null; steps?: Step[]; testId: string;
}) {
  const onChain = events.filter((e) => (e as { source?: string }).source === 'chain' || e.detail?.includes('on-chain')).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Timeline events={events} pending={steps ? pendingSteps(events, steps) : undefined} testId={testId} />
      <p className="small faint" data-testid={`${testId}-chain`}>
        {loading ? 'Reading the chain…' : error ? `Could not read the chain: ${error}` : onChain
          ? `${onChain} event${onChain === 1 ? '' : 's'} read from the chain (marked on-chain).`
          : 'Nothing about this on the chain yet.'}
      </p>
    </div>
  );
}

export type { Address };
