'use client';

import { useEffect, useRef, useState } from 'react';
import { checkoutAddress, readyToShip } from '@/lib/checkout.ts';
import { getRelayerUrl } from '@/lib/relayer-url.ts';
import { parsePaylink, receiptHref, shortAddress, type Paylink } from '@/lib/paylink.ts';
import './paylink.css';

type Paid = { orderId: string; explorerUrl: string; method: string };
const SCRIPT = '/tazor-pay.js';

/** Loads the same <tazor-pay-button> bundle merchants embed (public/tazor-pay.js), once. */
function loadButton(): Promise<void> {
  if (typeof customElements !== 'undefined' && customElements.get('tazor-pay-button')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    const s = existing ?? Object.assign(document.createElement('script'), { src: SCRIPT, async: true });
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => reject(new Error('Could not load the payment button.')), { once: true });
    if (!existing) document.head.append(s);
  });
}

/**
 * A hosted payment link: a business without a website shares /paylink/?m=&a=&ref=&n= (WhatsApp, SMS, a QR at the
 * counter) and the customer pays in USDT on Whitechain with one signature, a demo wallet, or a transfer from an exchange.
 */
export default function PaylinkPage() {
  const [link, setLink] = useState<Paylink | null>(null);
  const [error, setError] = useState('');
  const [paid, setPaid] = useState<Paid | null>(null);
  const [ready, setReady] = useState(false);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const r = parsePaylink(location.search);
    if (r.ok) setLink(r.link); else setError(r.error);
  }, []);

  useEffect(() => {
    if (!link || !slot.current) return;
    const host = slot.current;
    let cancelled = false;
    const onPaid = (e: Event) => {
      const d = (e as CustomEvent<{ orderId?: string; explorerUrl?: string; method?: string }>).detail ?? {};
      if (d.orderId) setPaid({ orderId: d.orderId, explorerUrl: d.explorerUrl ?? '', method: d.method ?? 'wallet' });
    };
    const onReady = () => setReady(true);
    loadButton().then(() => {
      if (cancelled) return;
      const b = document.createElement('tazor-pay-button');
      const attrs: Record<string, string> = {
        mode: 'wallet', 'demo-wallet': 'true', merchant: link.merchant, amount: link.amount, 'order-ref': link.ref,
        deadline: String(link.deadlineMinutes), 'ship-above': link.shipAbove, label: `Pay ${link.amount} USDT`,
      };
      const relayer = getRelayerUrl();
      if (relayer) attrs.relayer = relayer;
      const checkout = checkoutAddress();
      if (checkout) attrs.checkout = checkout;
      for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
      b.setAttribute('data-testid', 'pl-pay-button');
      b.addEventListener('tazor-paid', onPaid);
      b.addEventListener('tazor-ready', onReady);
      host.replaceChildren(b);
    }, (e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; host.replaceChildren(); };
  }, [link]);

  const wait = link && paid && !ready ? readyToShip(link.amount, 'sequencer', { waitForEthereumAbove: link.shipAbove }).reason : '';

  return (
    <div className="pl-screen" data-testid="paylink">
      <div className="pl-card">
        <span className="pl-test">Test mode · test USDT on Whitechain Sepolia</span>
        {error ? (
          <div className="pl-error" role="alert" data-testid="pl-error">{error}</div>
        ) : !link ? (
          <p className="pl-biz">Loading…</p>
        ) : (
          <>
            <p className="pl-biz">Pay <b data-testid="pl-name">{link.name}</b></p>
            <p className="pl-amount" data-testid="pl-amount">{link.amount}<span>USDT</span></p>
            <dl className="pl-kv">
              <dt>Order</dt><dd data-testid="pl-ref">{link.ref}</dd>
              <dt>Paid to</dt><dd className="mono" data-testid="pl-merchant" data-value={link.merchant} title={link.merchant}>{shortAddress(link.merchant)}</dd>
              <dt>Network</dt><dd>Whitechain (USDT, no gas needed)</dd>
            </dl>
            {/* stays mounted after payment: the button keeps watching finality and fires tazor-ready */}
            <div className="pl-button" ref={slot} />
            {paid && (
              <div className="pl-paid" data-testid="pl-paid" data-ready={String(ready)}>
                <b>{ready ? 'Paid ✓ · Ready to ship' : 'Paid ✓ · Wait'}</b>
                <span data-testid="pl-ship">{ready ? `${link.name} can hand over the order now.` : wait}</span>
                <span>
                  <a href={receiptHref(paid.orderId, link.ref)} data-testid="pl-receipt">View the receipt</a>
                  {paid.explorerUrl && <> · <a href={paid.explorerUrl} target="_blank" rel="noreferrer">Transaction ↗</a></>}
                </span>
              </div>
            )}
          </>
        )}
        <p className="pl-foot">Powered by <a href="/" target="_blank" rel="noreferrer">Tazor</a> · USDT on Whitechain</p>
      </div>
    </div>
  );
}
