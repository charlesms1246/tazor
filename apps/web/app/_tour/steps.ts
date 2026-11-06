/** Pure tour state: steps, persistence parsing, navigation and card placement (no DOM, no React). */

export type TourStep = { path: string; selector: string; title: string; body: string; company?: string };
export type TourState = { step: number; active: boolean };

export const TOUR_KEY = 'tazor.tour.v1';
export const TOUR_EVENT = 'tazor:tour';

export const STEPS: TourStep[] = [
  { path: '/', selector: '[data-tour="balance"]', title: 'Your company account', body: 'This is your company’s USDT balance on Whitechain. It belongs to the company, not to any one person.' },
  { path: '/', selector: '[data-tour="lanes"]', title: 'Everything that needs you', body: 'Invoices to pay, approvals to sign and money coming in, sorted by what is due first.' },
  { path: '/invoices/', selector: '[data-tour="invoice-form"]', title: 'Create an invoice as the supplier', body: 'Now you act as the supplier. Fill in the lines and send your customer an encrypted payment link.', company: 'bluejay' },
  { path: '/invoices/', selector: '[data-tour="invoice-paper"]', title: 'Your customer sees this', body: 'The invoice updates as you type. Only someone holding the link can read it.', company: 'bluejay' },
  { path: '/approvals/', selector: '[data-tour="approvals"]', title: 'Approve with your passkey', body: 'Back as the buyer, a verified approver signs with Face ID, fingerprint or device PIN. No seed phrase, no browser wallet.', company: 'acme' },
  { path: '/company/', selector: '[data-tour="people"]', title: 'Roles live on ENS', body: 'Who may approve for your company is written on its ENS name. Remove someone and they lose access within seconds.', company: 'acme' },
  { path: '/security/', selector: '[data-tour="fallback"]', title: 'If our servers are down, pay via Ethereum', body: 'A signed payment never depends on Tazor. You can send it through Ethereum and it still settles on Whitechain.' },
  { path: '/security/', selector: '[data-tour="health"]', title: 'Live system health', body: 'Each check here reads the chain directly, so you can see that every piece is working.' },
  { path: '/export/', selector: '[data-tour="reports"]', title: 'Close the books', body: 'Download every payment with its transaction proof as CSV, ready for your accountant.' },
];

export const INITIAL: TourState = { step: 0, active: false };

const clampStep = (n: number, total: number) => Math.min(Math.max(Math.trunc(n), 0), total - 1);

/** Reads a stored state; anything malformed falls back to an inactive tour at step 0. */
export function parseState(raw: string | null | undefined, total = STEPS.length): TourState {
  if (!raw) return INITIAL;
  try {
    const v = JSON.parse(raw) as Partial<TourState>;
    const step = typeof v.step === 'number' && Number.isFinite(v.step) ? clampStep(v.step, total) : 0;
    return { step, active: v.active === true };
  } catch {
    return INITIAL;
  }
}

/** Normalises a pathname to the trailing-slash form the static export uses. */
export const normalizePath = (p: string) => {
  const path = (p || '/').split(/[?#]/)[0] || '/';
  return path.endsWith('/') ? path : `${path}/`;
};

export type Move = { state: TourState; navigate: string | null };

/** The next step; past the last one the tour ends. navigate is set when the new step is on another page. */
export function nextStep(s: TourState, from: string, steps = STEPS): Move {
  if (s.step >= steps.length - 1) return { state: { step: 0, active: false }, navigate: null };
  const step = s.step + 1;
  const target = steps[step].path;
  return { state: { step, active: true }, navigate: normalizePath(from) === target ? null : target };
}

export function prevStep(s: TourState, from: string, steps = STEPS): Move {
  const step = Math.max(s.step - 1, 0);
  const target = steps[step].path;
  return { state: { step, active: true }, navigate: normalizePath(from) === target ? null : target };
}

export const endTour = (): TourState => ({ step: 0, active: false });

/** The step to show on this page, or null when the tour is off or the step belongs to another page. */
export function stepHere(s: TourState, path: string, steps = STEPS): TourStep | null {
  if (!s.active) return null;
  const st = steps[s.step];
  return st && st.path === normalizePath(path) ? st : null;
}

export type Rect = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };

/**
 * Where to put the card next to a target (viewport coordinates): below, else above, else right,
 * else left, always clamped inside the viewport with a margin. Centered when there is no target.
 */
export function placeCard(target: Rect | null, card: Size, vp: Size, gap = 14, margin = 12): { top: number; left: number; side: 'bottom' | 'top' | 'right' | 'left' | 'center' } {
  const clampX = (x: number) => Math.min(Math.max(x, margin), Math.max(margin, vp.width - card.width - margin));
  const clampY = (y: number) => Math.min(Math.max(y, margin), Math.max(margin, vp.height - card.height - margin));
  if (!target) return { top: clampY((vp.height - card.height) / 2), left: clampX((vp.width - card.width) / 2), side: 'center' };
  const bottom = target.top + target.height;
  const right = target.left + target.width;
  const cx = clampX(target.left + target.width / 2 - card.width / 2);
  const cy = clampY(target.top + target.height / 2 - card.height / 2);
  if (vp.height - bottom - margin >= card.height + gap) return { top: bottom + gap, left: cx, side: 'bottom' };
  if (target.top - margin >= card.height + gap) return { top: target.top - gap - card.height, left: cx, side: 'top' };
  if (vp.width - right - margin >= card.width + gap) return { top: cy, left: right + gap, side: 'right' };
  if (target.left - margin >= card.width + gap) return { top: cy, left: target.left - gap - card.width, side: 'left' };
  return { top: clampY(vp.height - card.height - margin), left: cx, side: 'bottom' };
}
