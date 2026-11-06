'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { currentCompany, setCompany } from '../../lib/company.ts';
import { INITIAL, STEPS, TOUR_EVENT, TOUR_KEY, endTour, nextStep, normalizePath, parseState, placeCard, prevStep, stepHere, type Rect, type TourState } from './steps.ts';
import './tour.css';

function readState(): TourState {
  try { return parseState(globalThis.localStorage?.getItem(TOUR_KEY)); } catch { return INITIAL; }
}

function writeState(s: TourState): void {
  try { globalThis.localStorage?.setItem(TOUR_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  globalThis.dispatchEvent?.(new Event(TOUR_EVENT));
}

const here = () => normalizePath(globalThis.location?.pathname ?? '/');

/** Starts the tour at step 1, navigating to its page when needed. */
export function startTour(): void {
  writeState({ step: 0, active: true });
  if (here() !== STEPS[0].path) globalThis.location?.assign(STEPS[0].path);
}

const PAD = 6;
const toRect = (r: DOMRect): Rect => ({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });

function useMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 900px)');
    const sync = () => setM(q.matches);
    sync();
    q.addEventListener('change', sync);
    return () => q.removeEventListener('change', sync);
  }, []);
  return m;
}

export function Tour() {
  const raw = usePathname() || '/';
  const path = normalizePath(raw);
  const [state, setState] = useState<TourState | null>(null);
  const [target, setTarget] = useState<Element | null>(null);
  const [searching, setSearching] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const mobile = useMobile();

  useEffect(() => {
    const sync = () => setState(readState());
    sync();
    window.addEventListener(TOUR_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(TOUR_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);

  const step = state ? stepHere(state, path) : null;
  const index = state?.step ?? 0;

  // The demo story switches company where a step says so.
  useEffect(() => {
    if (step?.company && currentCompany().id !== step.company) setCompany(step.company);
  }, [step]);

  // Pages render their data on the client, so give the anchor a moment to appear before centering.
  useEffect(() => {
    setTarget(null);
    setRect(null);
    if (!step) return;
    setSearching(true);
    let tries = 0;
    let found = false;
    const id = window.setInterval(() => {
      const el = document.querySelector(step.selector);
      if (el) {
        found = true;
        window.clearInterval(id);
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        setTarget(el);
        setSearching(false);
      } else if (++tries >= 25) {
        window.clearInterval(id);
        setSearching(false);
      }
    }, 100);
    return () => { window.clearInterval(id); if (!found) setSearching(false); };
  }, [step]);

  useEffect(() => {
    if (!target) return;
    let raf = 0;
    const measure = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setRect(toRect(target.getBoundingClientRect()))); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [target]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!step || !card || mobile) { setPos(null); return; }
    const p = placeCard(rect, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    setPos({ top: p.top, left: p.left });
  }, [rect, step, mobile, searching]);

  useEffect(() => {
    if (step && !searching) nextRef.current?.focus({ preventScroll: true });
  }, [step, searching]);

  const go = useCallback((move: { state: TourState; navigate: string | null }) => {
    writeState(move.state);
    if (move.navigate) window.location.assign(move.navigate);
  }, []);
  const onNext = () => state && go(nextStep(state, path));
  const onBack = () => state && go(prevStep(state, path));
  const onEnd = () => writeState(endTour());

  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[data-testid="cmdk"]')) writeState(endTour());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  if (!state || !state.active) return null;

  if (!step) {
    const st = STEPS[index];
    return (
      <div className="tour-paused" data-testid="tour-paused" role="status">
        <span>Tour paused at step {index + 1} of {STEPS.length}</span>
        <a className="btn btn-sm btn-primary" href={st.path} data-testid="tour-resume">Continue</a>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onEnd} data-testid="tour-end">End</button>
      </div>
    );
  }

  const last = index === STEPS.length - 1;
  const titleId = 'tour-title';
  const showRing = rect && !searching;
  const style = pos ? { top: pos.top, left: pos.left } : undefined;

  return (
    <div className="tour-layer" data-mobile={mobile ? 'true' : 'false'}>
      {showRing
        ? <div className="tour-ring" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} aria-hidden="true" />
        : <div className="tour-dim" aria-hidden="true" />}
      <div
        ref={cardRef}
        className="tour-card"
        data-placed={pos ? 'true' : 'false'}
        data-centered={!rect && !searching ? 'true' : 'false'}
        style={style}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-testid="tour-card"
      >
        <div className="tour-step" data-testid="tour-step">Step {index + 1} of {STEPS.length}</div>
        <h2 id={titleId} className="tour-title">{step.title}</h2>
        <p className="tour-body">{step.body}</p>
        <div className="tour-progress" aria-hidden="true">
          {STEPS.map((_, i) => <span key={i} data-on={i <= index ? 'true' : 'false'} />)}
        </div>
        <div className="tour-actions">
          <button type="button" className="btn btn-sm btn-ghost tour-end" onClick={onEnd} data-testid="tour-end">End tour</button>
          <span className="tour-spacer" />
          <button type="button" className="btn btn-sm" onClick={onBack} disabled={index === 0} data-testid="tour-back">Back</button>
          <button ref={nextRef} type="button" className="btn btn-sm btn-primary" onClick={onNext} data-testid="tour-next">{last ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
