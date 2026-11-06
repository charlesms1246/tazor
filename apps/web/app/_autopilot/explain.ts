import { friendlyError } from '../../lib/friendly-errors.ts';
import { plain } from '../../lib/human.ts';

/** What went wrong and what to do, in plain English. Timeouts keep their own message, which says what was awaited. */
export function explain(error: string): { title: string; fix: string; href?: string } {
  if (/^Timed out/.test(error)) return { title: plain(error), fix: 'Tap Retry to try this step again, or Skip to move on.' };
  const f = friendlyError(error);
  return f ?? { title: plain(error) || 'Something went wrong in this step.', fix: 'Tap Retry to try again, or Skip to move on.' };
}
