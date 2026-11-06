'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { ago, mailtoHref, whatsappHref } from '@/lib/reminders.ts';
import { recordRefundRequest, refundAmountError, refundDeepLink, refundRequestedAt, refundRequestMessage } from '@/lib/refund-request.ts';
import { toast } from '../_invoice/toast.tsx';
import { Card } from '../_ui/index.tsx';

/** On a receipt: the customer asks the business for a refund, with a link that opens the refund on the business's Checkout page. */
export function RefundRequest({ orderId, merchant, business, order, paid, paidOn, refundable }: {
  orderId: string; merchant: Address; business: string | null; order: string; paid: string; paidOn: string | null; refundable: number;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [last, setLast] = useState<number | null>(null);
  const [origin, setOrigin] = useState('');
  useEffect(() => { setLast(refundRequestedAt(orderId)); setOrigin(location.origin); }, [orderId]);

  const err = refundAmountError(amount, refundable);
  const ready = !err && reason.trim().length > 0;
  const m = refundRequestMessage({
    business, order, paid, paidOn, amount, reason,
    deepLink: refundDeepLink(origin, merchant, orderId, amount), receipt: typeof location === 'undefined' ? '' : location.href,
  });
  const sent = (how: string) => { recordRefundRequest(orderId); setLast(Date.now()); toast(`Refund request ready in ${how}`); };

  return (
    <Card title="Need a refund?" subtitle="Ask the business. A refund can only come back to you, and never for more than you paid." testId="rr">
      {last && <p className="small" style={{ margin: '0 0 8px' }} data-testid="rr-last">Refund requested {ago(last)}.</p>}
      {!open ? (
        <button type="button" className="btn" data-testid="rr-open" onClick={() => setOpen(true)}>Request a refund</button>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <label className="field"><span className="field-label">Reason</span>
            <textarea className="input" rows={3} data-testid="rr-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: one item arrived damaged" maxLength={400} />
          </label>
          <label className="field"><span className="field-label">Amount (USDT, optional)</span>
            <input className="input num" inputMode="decimal" data-testid="rr-amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Empty = the full ${refundable.toFixed(2)} USDT`} />
          </label>
          {err && <p className="small" style={{ margin: 0, color: 'var(--negative)' }} data-testid="rr-error">{err}</p>}
          {!reason.trim() && <p className="small muted" style={{ margin: 0 }}>Add a reason to get the message.</p>}
          {ready && (<>
            <pre className="rm-text" data-testid="rr-text">{m.body}</pre>
            <div className="row" style={{ gap: 8 }}>
              <a className="btn btn-primary" href={whatsappHref(m.body)} target="_blank" rel="noreferrer" data-testid="rr-whatsapp" onClick={() => sent('WhatsApp')}>WhatsApp</a>
              <a className="btn" href={mailtoHref(m.subject, m.body)} data-testid="rr-email" onClick={() => sent('your email app')}>Email</a>
              <button type="button" className="btn" data-testid="rr-copy"
                onClick={() => navigator.clipboard?.writeText(m.body).then(() => sent('the clipboard'), () => toast('Could not copy; select the text and copy it', 'error'))}>Copy</button>
            </div>
          </>)}
        </div>
      )}
    </Card>
  );
}
