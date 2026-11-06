'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import { buildPaylink, MAX_PAYLINK_USDT } from '@/lib/paylink.ts';
import {
  amountError, buttonSnippet, createDemoWallet, dashboardHref, DEMO_WEBHOOK_SECRET, loadDemoWallet, loadStart, newWebhookSecret, refError,
  reportsHref, saveStart, shipError, START_DEFAULTS, webhookConfig, webhookError, type StartForm,
} from '@/lib/start.ts';
import { AddrChip } from '../_human/chip.tsx';
import { Qr } from '../_invoice/paper.tsx';
import { toast, Toasts } from '../_invoice/toast.tsx';
import { Card, Field, Notice, PageHeader } from '../_ui/index.tsx';
import '../_invoice/touch.css';
import '../_invoice/paper.css';
import '../_checkout/checkout.css';
import './start.css';

type Eth = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const injected = (): Eth | null => (globalThis as { ethereum?: Eth }).ethereum ?? null;
const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast('Could not copy; select it and copy by hand', 'error'));

/** Merchant onboarding: a business sets up to accept USDT in about a minute. */
export default function StartPage() {
  const [f, setF] = useState<StartForm>(START_DEFAULTS);
  const [origin, setOrigin] = useState('');
  const [demoWallet, setDemoWallet] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  useEffect(() => { setF(loadStart()); setOrigin(location.origin); setDemoWallet(loadDemoWallet()); setSecret(newWebhookSecret()); }, []);
  const set = (k: keyof StartForm) => (e: { target: { value: string } }) => setF((x) => { const n = { ...x, [k]: e.target.value }; saveStart(n); return n; });
  const put = (k: keyof StartForm, v: string) => setF((x) => { const n = { ...x, [k]: v }; saveStart(n); return n; });

  const wallet = f.wallet.trim();
  const walletOk = isAddress(wallet, { strict: false });
  const usesDemo = walletOk && !!demoWallet && demoWallet.toLowerCase() === wallet.toLowerCase();
  const errs = { ship: shipError(f.shipAbove), amount: amountError(f.amount, MAX_PAYLINK_USDT), ref: refError(f.ref), webhook: webhookError(f.webhook) };
  const name = f.name.trim() || 'Your business';

  const link = useMemo(() => (walletOk && !errs.amount && !errs.ref && origin
    ? buildPaylink({ merchant: getAddress(wallet), amount: f.amount.trim(), ref: f.ref.trim(), name: f.name.trim() || undefined, ship: errs.ship ? undefined : f.shipAbove.trim() }, origin)
    : ''), [walletOk, wallet, f.amount, f.ref, f.name, f.shipAbove, errs.amount, errs.ref, errs.ship, origin]);
  const snippet = walletOk && origin
    ? buttonSnippet({ origin, merchant: wallet, shipAbove: errs.ship ? '100' : f.shipAbove.trim(), amount: errs.amount ? '10.00' : f.amount.trim(), ref: errs.ref ? 'ORDER-1001' : f.ref.trim(), demoWallet: true })
    : '';

  const useMine = async () => {
    const eth = injected();
    if (!eth) return toast('No wallet in this browser. Paste your address, or create a demo wallet.', 'error');
    try { const [a] = (await eth.request({ method: 'eth_requestAccounts' })) as string[]; if (a) { put('wallet', getAddress(a)); toast('Your wallet is the settlement wallet'); } }
    catch { toast('The wallet did not share an address', 'error'); }
  };
  const makeDemo = () => { const a = createDemoWallet(); setDemoWallet(a); put('wallet', a); toast('Demo wallet created in this browser'); };

  return (
    <div className="page tz-touch start-page">
      <Toasts />
      <PageHeader title="Start accepting USDT" subtitle="Set up in about a minute. Your customers pay in USDT on Whitechain with one signature: no gas, no WBT." />

      <section className="start-flow" aria-label="How it works" data-testid="start-diagram">
        <div className="start-node"><span className="start-n">1</span><b>Tazor serves you</b><span>Checkout, refunds, receipts and reports. The relayer pays the gas.</span></div>
        <span className="start-arrow" aria-hidden="true">→</span>
        <div className="start-node"><span className="start-n">2</span><b>You serve your customers</b><span>A pay button on your site, or a payment link for chat, email or a QR on the counter.</span></div>
        <span className="start-arrow" aria-hidden="true">→</span>
        <div className="start-node"><span className="start-n">3</span><b>They pay without gas</b><span>One signature in their wallet, or a transfer from an exchange. Refunds go back to them only.</span></div>
      </section>

      <Card title="1. Your business" subtitle="Saved in this browser only.">
        <div className="fields">
          <Field label="Business name"><input className="input" data-testid="start-name" value={f.name} onChange={set('name')} placeholder="Chai Point, Bandra" maxLength={80} /></Field>
          <Field label="Settlement wallet" hint="Where payments arrive. Paste an address, use the wallet in this browser, or create a demo wallet.">
            <input className="input mono" data-testid="start-wallet" value={f.wallet} onChange={set('wallet')} placeholder="0x…" spellCheck={false} />
          </Field>
          <div className="row start-wallet-actions">
            <button type="button" className="btn" data-testid="start-use-wallet" onClick={useMine}>Use my wallet</button>
            <button type="button" className="btn" data-testid="start-demo-wallet" onClick={makeDemo}>{demoWallet ? 'Use my demo wallet' : 'Create a demo wallet'}</button>
          </div>
          {f.wallet.trim() && !walletOk && <Notice tone="negative" testId="start-wallet-error">That is not a wallet address. It starts with 0x and has 42 characters.</Notice>}
          {usesDemo && <Notice tone="warning" testId="start-demo-note">Demo wallet: testnet only, and its key lives in this browser. Clearing site data loses it. Refunds from it work on the Checkout page in this browser.</Notice>}
          <Field label="Wait for Ethereum above (USDT)" hint="Payments under this are ready to ship at once. Bigger ones wait until Whitechain posts them to Ethereum, about 10 minutes.">
            <input className="input num" inputMode="decimal" data-testid="start-ship" value={f.shipAbove} onChange={set('shipAbove')} />
          </Field>
          {errs.ship && <p className="small start-err">{errs.ship}</p>}
          <Field label="Webhook address (optional)" hint="Where Tazor tells your system about payments, refunds and when an order is ready to ship.">
            <input className="input mono" data-testid="start-webhook" value={f.webhook} onChange={set('webhook')} placeholder="https://shop.example/tazor-webhook" spellCheck={false} />
          </Field>
          {errs.webhook && <p className="small start-err" data-testid="start-webhook-error">{errs.webhook}</p>}
        </div>
      </Card>

      {!walletOk ? (
        <Card><p className="muted" style={{ margin: 0 }} data-testid="start-waiting">Add a settlement wallet above and your pay button, payment link and dashboard appear here.</p></Card>
      ) : (<>
        <Card title="2. Your dashboard" subtitle={<>Payments to <AddrChip value={getAddress(wallet)} /> for {name}.</>} testId="start-links">
          <div className="row">
            <a className="btn btn-primary" href={dashboardHref(wallet)} data-testid="start-dashboard">Open your Checkout dashboard</a>
            <a className="btn" href={reportsHref(wallet)} data-testid="start-reports">Open your Reports</a>
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>Orders, refunds, subscriptions and webhooks; Reports has the CSV for your accountant.</p>
        </Card>

        <Card title="3. A payment link (no website needed)" subtitle="Send it on WhatsApp, SMS or email, or print the QR for your counter." testId="start-paylink">
          <div className="fields start-link-fields">
            <Field label="Amount (USDT)"><input className="input num" inputMode="decimal" data-testid="start-amount" value={f.amount} onChange={set('amount')} /></Field>
            <Field label="Order number"><input className="input" data-testid="start-ref" value={f.ref} onChange={set('ref')} maxLength={64} /></Field>
          </div>
          {(errs.amount || errs.ref) && <p className="small start-err" data-testid="start-link-error">{errs.amount ?? errs.ref}</p>}
          {link && (
            <div className="start-share">
              <Qr link={link} testId="start-qr" />
              <div className="stack" style={{ gap: 8 }}>
                <b>{name}: {f.amount.trim()} USDT for order {f.ref.trim()}</b>
                <div className="row">
                  <button type="button" className="btn btn-primary" data-testid="start-copy-link" data-link={link} onClick={() => copy(link, 'Payment link')}>Copy payment link</button>
                  <a className="btn" href={link} target="_blank" rel="noreferrer" data-testid="start-open-link">Open</a>
                </div>
                <span className="small muted">Each order number gets its own receipt. Use a new one for every sale.</span>
              </div>
            </div>
          )}
        </Card>

        <Card title="4. A pay button for your website" subtitle="Paste this where your checkout shows the total. Change amount and order-ref per order." testId="start-snippet-card">
          <pre className="co-code start-code" data-testid="start-snippet">{snippet}</pre>
          <div className="row"><button type="button" className="btn" data-testid="start-copy-snippet" onClick={() => copy(snippet, 'Snippet')}>Copy snippet</button></div>
          <p className="small muted" style={{ margin: '8px 0 0' }}><code>demo-wallet=&quot;true&quot;</code> lets testers pay from a wallet kept in their browser. Remove it for real customers.</p>
        </Card>

        <Card title="Webhooks" subtitle="Signed with a shared secret, so your system can trust each event came from Tazor." testId="start-webhooks">
          {f.webhook.trim() && !errs.webhook ? (<>
            <p className="small" style={{ margin: 0 }}>The secret lives in the relayer&apos;s configuration. Give this entry for <code>WEBHOOKS_JSON</code> to whoever runs your relayer, and keep the secret in your server to check each delivery&apos;s <code>Tazor-Signature</code>.</p>
            <pre className="co-code start-code" data-testid="start-webhook-config">{webhookConfig(wallet, f.webhook.trim(), secret, errs.ship ? '100' : f.shipAbove.trim())}</pre>
            <div className="row"><button type="button" className="btn" data-testid="start-copy-webhook" onClick={() => copy(webhookConfig(wallet, f.webhook.trim(), secret, errs.ship ? '100' : f.shipAbove.trim()), 'Webhook entry')}>Copy entry</button></div>
          </>) : <p className="small muted" style={{ margin: 0 }}>Add a webhook address above to get your relayer entry and secret.</p>}
          <p className="small muted" style={{ margin: '8px 0 0' }} data-testid="start-test-secret">On the shared demo relayer, events for businesses without their own entry are signed with the public test secret <code>{DEMO_WEBHOOK_SECRET}</code>. Fine for trying it out; never use it for real orders.</p>
        </Card>
      </>)}
    </div>
  );
}
