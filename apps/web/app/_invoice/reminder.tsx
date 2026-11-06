'use client';

import { useEffect, useState } from 'react';
import { ago, lastReminded, mailtoHref, markReminded, REMINDED, reminderMessage, whatsappHref } from '@/lib/reminders.ts';
import { toast } from './toast.tsx';
import './reminder.css';

/** "Send reminder": a ready-to-send, polite message over WhatsApp, email or the clipboard; remembers when it was last sent here. */
export function ReminderButton({ remindKey, to, from, what, amount, dueMs, link }: {
  remindKey: string; to?: string | null; from: string; what: string; amount: string; dueMs: number | null; link: string;
}) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const sync = () => setLast(lastReminded(remindKey));
    sync();
    globalThis.addEventListener(REMINDED, sync);
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => { globalThis.removeEventListener(REMINDED, sync); clearInterval(t); };
  }, [remindKey]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  const m = reminderMessage({ to, from, what, amount, dueMs, link });
  const sent = (how: string) => { markReminded(remindKey); setLast(Date.now()); toast(`Reminder ready in ${how}`); };

  return (
    <span className="rm" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn btn-sm" data-testid="reminder-open" onClick={() => setOpen(true)}>Send reminder</button>
      {last && <span className="cell-sub" data-testid="reminder-last">Reminded {ago(last)}</span>}
      {open && (
        <>
          <div className="rm-overlay" onClick={() => setOpen(false)} />
          <div className="rm-dialog" role="dialog" aria-modal="true" aria-label="Send a reminder" data-testid="reminder-panel">
            <h3>Send a reminder</h3>
            <p className="small muted" style={{ margin: 0 }}>Ready to send. Nothing is sent until you press send in WhatsApp or your email app.</p>
            <pre className="rm-text" data-testid="reminder-text">{m.body}</pre>
            <div className="rm-actions">
              <a className="btn btn-primary" href={whatsappHref(m.body)} target="_blank" rel="noreferrer" data-testid="reminder-whatsapp" onClick={() => sent('WhatsApp')}>WhatsApp</a>
              <a className="btn" href={mailtoHref(m.subject, m.body)} data-testid="reminder-email" onClick={() => sent('your email app')}>Email</a>
              <button type="button" className="btn" data-testid="reminder-copy"
                onClick={() => navigator.clipboard?.writeText(m.body).then(() => sent('the clipboard'), () => toast('Could not copy; select the text and copy it', 'error'))}>Copy</button>
              <button type="button" className="btn btn-ghost" data-testid="reminder-close" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}
