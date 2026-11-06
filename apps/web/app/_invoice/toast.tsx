'use client';

import { useEffect, useState } from 'react';
import './toast.css';

export type ToastTone = 'success' | 'error' | 'info';
type Toast = { id: number; text: string; tone: ToastTone };

const EVENT = 'tazor:toast';
let next = 1;

/** Shows a short message in the page's <Toasts /> region (no-op on the server). */
export function toast(text: string, tone: ToastTone = 'success') {
  globalThis.dispatchEvent?.(new CustomEvent<Toast>(EVENT, { detail: { id: next++, text, tone } }));
}

/** The toast region: put one on a page. Success toasts leave after 3.5 s, errors after 6 s; announced politely. */
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setList((l) => [...l.slice(-2), t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.tone === 'error' ? 6000 : 3500);
    };
    addEventListener(EVENT, on);
    return () => removeEventListener(EVENT, on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite" aria-atomic="false" data-testid="toasts">
      {list.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone} data-testid="toast">
          <span className="toast-mark" aria-hidden="true">{t.tone === 'success' ? '✓' : t.tone === 'error' ? '!' : 'i'}</span>
          <span>{t.text}</span>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>×</button>
        </div>
      ))}
    </div>
  );
}
