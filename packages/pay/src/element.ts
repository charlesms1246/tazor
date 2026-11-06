// <tazor-pay-button>: a framework-free custom element that creates a Tazor payment link, opens it, and waits for payment.
import { createInvoiceLink, DEFAULT_EXPLORER, watchPayment, type InvoiceInput, type InvoiceLink, type LineInput, type Payment } from './core.ts';
import { accountSigner, CHECKOUT, EXPLORER, orderId, orderRef, payOrder, readyToShip, RELAYER_URL, walletSigner, watchOrder, type Eip1193, type Order, type ShipPolicy, type Signer, type Stage } from './checkout.ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { addressQrSvg, depositOrder, paymentUri, watchDeposit, type DepositOrder, type DepositStatus } from './deposit.ts';

export const ATTRIBUTES = [
  'supplier-name', 'supplier-account', 'payee', 'buyer', 'amount', 'lines', 'memo', 'due', 'app-url', 'label',
  'invoice-id', 'tax-rate', 'tax-label', 'explorer', 'target',
  // mode="wallet": gasless wallet checkout (one signature, no gas)
  'mode', 'merchant', 'order-ref', 'deadline', 'relayer', 'checkout',
  // offer "Pay from WhiteBIT or any exchange" (plain USDT transfer to a per-order address); "false" hides it
  'deposit',
  'demo-wallet',
  // payments at or above this many USDT fire tazor-ready only once posted to Ethereum (default 100)
  'ship-above',
] as const;

export type WalletPaidDetail = { orderId: `0x${string}`; txHash: `0x${string}`; explorerUrl: string; payer: string; amount: string; ref: string };

const STAGE_TEXT: Record<Stage, string> = { pending: 'Submitted', sequencer: 'Confirmed on Whitechain', ethereum: 'Posted to Ethereum', finalized: 'Final' };

/** The order a wallet-mode button pays: amount in USDT, order-ref your order number, deadline in minutes from now (default 30). */
export function orderFromAttributes(get: (name: string) => string | null, now = Math.floor(Date.now() / 1000)): Order {
  const merchant = get('merchant')?.trim();
  if (!merchant || !/^0x[0-9a-fA-F]{40}$/.test(merchant)) throw new Error('<tazor-pay-button mode="wallet"> needs merchant="0x…"');
  const amount = get('amount')?.trim() ?? '';
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new Error('amount must be a USDT amount like "1.55"');
  const [w, f = ''] = amount.split('.');
  const ref = get('order-ref')?.trim();
  if (!ref) throw new Error('<tazor-pay-button mode="wallet"> needs order-ref (your order number)');
  const minutes = Number(get('deadline') ?? 30);
  return { merchant: merchant as `0x${string}`, amount: BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0')), ref: orderRef(ref), deadline: BigInt(now + Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60)) };
}

export type PaidDetail = Payment & { invoiceHash: `0x${string}`; explorerUrl: string; url: string; id: string };

const STYLE = `
:host { display: inline-block; font-family: var(--tazor-font, "Onest", system-ui, -apple-system, "Segoe UI", sans-serif); }
.wrap { display: inline-flex; flex-direction: column; gap: 6px; align-items: flex-start; }
button {
  display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 18px; cursor: pointer;
  border: 0; border-radius: var(--tazor-radius, 12px); font: inherit; font-weight: 600; font-size: 15px;
  background: var(--tazor-bg, #080a28); color: var(--tazor-fg, #ffffff);
}
button:hover { background: var(--tazor-bg-hover, #000a47); }
button:focus-visible { outline: 3px solid var(--tazor-focus, #0066ff); outline-offset: 2px; }
button[disabled] { cursor: default; }
button[data-state="paid"] { background: var(--tazor-paid-bg, #ddf8ee); color: var(--tazor-paid, #0b7350); }
button[data-state="paid"] .mark { background: var(--tazor-paid, #0b7350); color: #ffffff; }
.mark { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--tazor-accent, #dcf218); color: var(--tazor-bg, #080a28); font-size: 13px; font-weight: 800; }
.status { font-size: 13px; color: var(--tazor-muted, #4a5567); }
.status[data-state="paid"] { color: var(--tazor-paid, #0b7350); font-weight: 600; }
.status[data-state="error"] { color: var(--tazor-error, #c4342c); }
a { color: inherit; }
.alt { background: none; color: var(--tazor-bg, #080a28); border: 1px solid var(--tazor-border, #c7d0dc); min-height: 40px; font-weight: 500; }
.alt:hover { background: var(--tazor-raised, #f3f5f6); }
.dep { display: grid; gap: 10px; margin-top: 6px; padding: 14px; max-width: 360px; border: 1px solid var(--tazor-border, #e6e6ec); border-radius: var(--tazor-radius, 12px); font-size: 14px; }
.dep input { min-height: 40px; padding: 0 10px; border: 1px solid var(--tazor-border, #c7d0dc); border-radius: 10px; font: 13px ui-monospace, Menlo, monospace; }
.dep .qr { width: 168px; height: 168px; } .dep .qr svg { width: 100%; height: 100%; }
.dep .kv { display: grid; grid-template-columns: 80px 1fr; gap: 6px 10px; align-items: center; }
.dep .k { color: var(--tazor-muted, #4a5567); font-size: 13px; }
.dep .copy { min-height: 30px; padding: 0 10px; font-size: 12px; font-weight: 500; }
.dep .note { font-size: 12px; color: var(--tazor-muted, #4a5567); }
.dep ol { margin: 0; padding-left: 18px; display: grid; gap: 2px; font-size: 13px; }
.dep li[data-on="true"] { color: var(--tazor-paid, #0b7350); font-weight: 600; }
.mono { font-family: ui-monospace, Menlo, monospace; }
`;

const DEPOSIT_STEPS: [DepositStatus['status'][], string][] = [
  [['waiting'], 'Waiting for your transfer'], [['received'], 'Transfer received'], [['paid'], 'Paid to the merchant'], [['ethereum', 'finalized'], 'Posted to Ethereum'],
];
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const due14 = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

/** Reads the element's attributes into createInvoiceLink input. */
export function inputFromAttributes(get: (name: string) => string | null): InvoiceInput {
  const req = (n: string) => {
    const v = get(n)?.trim();
    if (!v) throw new Error(`<tazor-pay-button> needs the ${n} attribute`);
    return v;
  };
  let lines: LineInput[];
  const rawLines = get('lines');
  if (rawLines) {
    try { lines = JSON.parse(rawLines); } catch { throw new Error('lines must be JSON: [{"description","quantity","unitPrice"}]'); }
    if (!Array.isArray(lines) || lines.length === 0) throw new Error('lines must be a non-empty JSON array');
  } else {
    lines = [{ description: get('memo')?.trim() || 'Order', quantity: 1, unitPrice: req('amount') }];
  }
  return {
    supplierName: req('supplier-name'), supplierAccount: get('supplier-account') ?? undefined, payee: req('payee'),
    buyerAccount: req('buyer'), lines, memo: get('memo') ?? '', dueDate: get('due') || due14(),
    id: get('invoice-id') || undefined, appUrl: get('app-url') || undefined,
    taxRate: get('tax-rate') ?? undefined, taxLabel: get('tax-label') ?? undefined,
  };
}

/** Registers <tazor-pay-button> (or another tag). Safe to call twice; a no-op outside the browser. */
export function defineTazorPayButton(tag = 'tazor-pay-button'): void {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;

  class TazorPayButton extends HTMLElement {
    static observedAttributes = [...ATTRIBUTES];
    #root = this.attachShadow({ mode: 'open' });
    #link: Promise<InvoiceLink> | null = null;
    #stop: (() => void) | null = null;
    #state: 'idle' | 'waiting' | 'paid' | 'error' = 'idle';
    #txUrl = '';
    #error = '';

    /** The payment link for the current attributes (created once per attribute set). */
    get link(): Promise<InvoiceLink> {
      this.#link ??= createInvoiceLink(inputFromAttributes((n) => this.getAttribute(n))).then((l) => {
        this.dispatchEvent(new CustomEvent('tazor-link', { detail: l, bubbles: true, composed: true }));
        return l;
      });
      return this.#link;
    }

    connectedCallback() {
      this.#render();
      if (!this.#wallet()) this.link.then(() => this.#render(), (e) => this.#fail(e));
    }
    disconnectedCallback() { this.#stop?.(); }
    attributeChangedCallback(name: string, old: string | null, value: string | null) {
      if (old === value || this.#state === 'paid' || name === 'label') return void (this.isConnected && this.#render());
      this.#link = null;
      if (this.isConnected && !this.#wallet()) this.link.then(() => this.#render(), (e) => this.#fail(e));
      else if (this.isConnected) this.#render();
    }

    #wallet = () => this.getAttribute('mode') === 'wallet';
    #readySent = false;
    #shipNote = '';
    #policy = (): ShipPolicy => {
      const v = this.getAttribute('ship-above')?.trim();
      return { waitForEthereumAbove: v && /^\d+(\.\d{1,6})?$/.test(v) ? v : '100' };
    };
    /** tazor-ready once the payment may ship: at once for small amounts, after Ethereum for big ones (ship-above). */
    #maybeReady(orderId: string, stage: Stage | null, extra: Record<string, unknown> = {}) {
      if (this.#readySent) return;
      const amount = this.getAttribute('amount')?.trim() ?? '0';
      let d;
      try { d = readyToShip(amount, stage, this.#policy()); } catch { return; }
      if (!d.ready) {
        this.#shipNote = stage && stage !== 'pending' ? 'Payment received; waiting for Whitechain to post it to Ethereum (big payments only)' : '';
        return;
      }
      this.#readySent = true;
      this.#shipNote = '';
      this.dispatchEvent(new CustomEvent('tazor-ready', { detail: { orderId, stage, waitFor: d.waitFor, reason: d.reason, ...extra }, bubbles: true, composed: true }));
    }
    #stage: Stage | null = null;
    #dep: { open: boolean; refundTo: string; busy: boolean; error: string; order?: DepositOrder; address?: string; id?: string; qr?: string; uri?: string; status?: DepositStatus } = { open: false, refundTo: '', busy: false, error: '' };

    async #openDeposit() {
      this.#dep = { ...this.#dep, open: true, error: '' };
      // prefill the refund address with an already-connected wallet, without asking for a connection
      const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
      if (!this.#dep.refundTo && eth) { try { const [a] = (await eth.request({ method: 'eth_accounts' })) as string[]; if (a) this.#dep.refundTo = a; } catch { /* no wallet connected */ } }
      this.#render();
    }

    async #startDeposit() {
      const refundTo = this.#dep.refundTo.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(refundTo)) { this.#dep.error = 'Enter the Whitechain address where a refund (or any excess) should go.'; return this.#render(); }
      this.#dep = { ...this.#dep, busy: true, error: '' }; this.#render();
      try {
        const o = orderFromAttributes((n) => this.getAttribute(n));
        const d = await depositOrder({ merchant: o.merchant, amount: o.amount, ref: o.ref, deadline: o.deadline, refundTo, relayer: this.getAttribute('relayer') || undefined });
        this.#dep = { ...this.#dep, busy: false, order: d.order, address: d.depositAddress, id: d.orderId, uri: paymentUri(d.depositAddress, d.order.amount), qr: await addressQrSvg(paymentUri(d.depositAddress, d.order.amount)), status: { status: 'waiting' } };
        this.#render();
        this.#stop?.();
        this.#stop = watchDeposit(d.order, (st) => {
          this.#dep.status = st;
          if ((st.status === 'paid' || st.status === 'ethereum' || st.status === 'finalized') && this.#state !== 'paid') {
            this.#state = 'paid';
            this.#txUrl = st.explorer || (st.txHash ? `${this.getAttribute('explorer') ?? EXPLORER}/tx/${st.txHash}` : '');
            const detail = { method: 'deposit', orderId: d.orderId, txHash: st.txHash ?? '', explorerUrl: this.#txUrl, payer: refundTo, amount: this.getAttribute('amount') ?? '', ref: this.getAttribute('order-ref') ?? '' };
            this.dispatchEvent(new CustomEvent('tazor-paid', { detail, bubbles: true, composed: true }));
          }
          if (st.status === 'paid' || st.status === 'ethereum' || st.status === 'finalized') {
            this.#maybeReady(d.orderId, st.status === 'paid' ? 'sequencer' : st.status, { method: 'deposit', txHash: st.txHash ?? '' });
          }
          this.#render();
        }, { relayer: this.getAttribute('relayer') || undefined });
      } catch (e) {
        this.#dep = { ...this.#dep, busy: false, error: e instanceof Error ? e.message : String(e) };
        this.#render();
      }
    }

    #demoNote = '';
    #renderDemo(wrap: Element) {
      if (!this.#wallet() || this.getAttribute('demo-wallet') !== 'true') return;
      if (this.#state !== 'paid' && !this.#dep.open) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'alt'; b.setAttribute('part', 'demo-button'); b.dataset.testid = 'tazor-demo-wallet';
        b.textContent = 'Pay with a demo wallet (no extension)'; b.disabled = this.#state === 'waiting';
        b.addEventListener('click', () => void this.#payWithWallet(true));
        wrap.append(b);
      }
      if (this.#demoNote) { const n = document.createElement('span'); n.className = 'note'; n.textContent = this.#demoNote; wrap.append(n); }
    }

    #renderDeposit(wrap: Element) {
      if (!this.#wallet() || this.getAttribute('deposit') === 'false' || this.#state === 'paid' && !this.#dep.open) return;
      if (!this.#dep.open) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'alt'; b.setAttribute('part', 'deposit-button'); b.textContent = 'Pay from WhiteBIT or any exchange';
        b.addEventListener('click', () => void this.#openDeposit());
        wrap.append(b);
        return;
      }
      const box = document.createElement('div');
      box.className = 'dep'; box.setAttribute('part', 'deposit');
      const el = (tag: string, cls = '', text = '') => { const x = document.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x; };
      const copy = (value: string, label: string) => {
        const b = el('button', 'alt copy', label) as HTMLButtonElement; b.type = 'button';
        b.addEventListener('click', () => { navigator.clipboard?.writeText(value).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = label; }, 1200); }, () => undefined); });
        return b;
      };
      if (!this.#dep.address) {
        box.append(el('b', '', 'Pay by transfer'));
        box.append(el('span', 'note', 'First, where should a refund (or any excess) go? Your Whitechain address:'));
        const input = el('input') as HTMLInputElement;
        input.value = this.#dep.refundTo; input.placeholder = '0x…'; input.spellcheck = false; input.setAttribute('aria-label', 'Refund address');
        input.addEventListener('input', () => { this.#dep.refundTo = input.value; });
        const go = el('button', '', this.#dep.busy ? 'Preparing…' : 'Show the payment address') as HTMLButtonElement;
        go.type = 'button'; go.disabled = this.#dep.busy;
        go.addEventListener('click', () => void this.#startDeposit());
        box.append(input, go);
      } else {
        const amount = this.getAttribute('amount') ?? '';
        const qr = el('div', 'qr'); qr.innerHTML = this.#dep.qr ?? ''; qr.setAttribute('aria-label', 'QR code of the payment address');
        const kv = el('div', 'kv');
        const addrRow = el('span'); addrRow.append(el('span', 'mono', shortAddr(this.#dep.address)), document.createTextNode(' '), copy(this.#dep.address, 'Copy address'));
        const amtRow = el('span'); amtRow.append(el('b', '', `${amount} USDT`), document.createTextNode(' '), copy(amount, 'Copy amount'));
        const linkRow = el('span'); if (this.#dep.uri) linkRow.append(copy(this.#dep.uri, 'Copy payment link'), document.createTextNode(' '), el('span', 'note', 'EIP-681: wallet apps fill in the token, network and amount'));
        kv.append(el('span', 'k', 'Send'), amtRow, el('span', 'k', 'Token'), el('span', '', 'USDT'), el('span', 'k', 'Network'), el('span', '', 'Whitechain'), el('span', 'k', 'To'), addrRow, el('span', 'k', 'Link'), linkRow);
        box.append(el('b', '', 'Withdraw from WhiteBIT (or send from any wallet)'), qr, kv);
        box.append(el('span', 'note', `Send exactly ${amount} USDT on Whitechain. Any extra comes back to ${shortAddr(this.#dep.refundTo)}; so does everything if the order expires. Testnet: any USDT transfer on Whitechain Sepolia stands in for the WhiteBIT withdrawal.`));
        const ol = el('ol');
        const cur = this.#dep.status?.status ?? 'waiting';
        const reached = DEPOSIT_STEPS.findIndex(([ks]) => ks.includes(cur));
        DEPOSIT_STEPS.forEach(([, label], i) => { const li = el('li', '', label); li.dataset.on = String(i <= reached); ol.append(li); });
        if (cur === 'returned') ol.append(el('li', '', 'Returned to your refund address'));
        if (cur === 'expired') ol.append(el('li', '', 'Expired: anything sent goes back to your refund address'));
        box.append(ol);
      }
      if (this.#dep.error) box.append(el('span', 'note', this.#dep.error));
      wrap.append(box);
    }

    /** A wallet made inside this page (testnet demos only): no extension, no seed phrase; the sandbox tops it up with test USDT. */
    async #demoSigner(relayer: string | undefined): Promise<Signer> {
      const KEY = 'tazor.demo-wallet.v1';
      let pk = (() => { try { return globalThis.localStorage?.getItem(KEY); } catch { return null; } })() as `0x${string}` | null;
      if (!pk || !/^0x[0-9a-f]{64}$/i.test(pk)) { pk = generatePrivateKey(); try { globalThis.localStorage?.setItem(KEY, pk); } catch { /* private mode: a one-off wallet */ } }
      const account = privateKeyToAccount(pk);
      this.#demoNote = `Demo wallet ${shortAddr(account.address)}: getting test USDT…`; this.#render();
      const base = (relayer ?? RELAYER_URL).replace(/\/+$/, '');
      const r = await fetch(`${base}/sandbox/counterparty`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fund-demo-wallet', address: account.address }) });
      const j = (await r.json().catch(() => ({}))) as { status?: string; error?: string; reason?: string };
      if (!r.ok && !/already topped up/.test(j.error ?? j.reason ?? '')) throw new Error(j.reason ?? j.error ?? `the sandbox returned ${r.status}`);
      this.#demoNote = `Demo wallet ${shortAddr(account.address)} (in this browser, testnet only): signing…`; this.#render();
      return accountSigner(account);
    }

    async #payWithWallet(demo = false) {
      if (this.#state === 'paid' || this.#state === 'waiting') return;
      const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
      try {
        if (!demo && !eth) throw new Error('No browser wallet found. Use "Pay with a demo wallet", pay from an exchange, or install a wallet.');
        const order = orderFromAttributes((n) => this.getAttribute(n));
        const checkout = (this.getAttribute('checkout') || CHECKOUT) as `0x${string}`;
        const relayer = this.getAttribute('relayer') || undefined;
        this.#state = 'waiting'; this.#stage = null; this.#render();
        const wallet = demo ? await this.#demoSigner(relayer) : await walletSigner(eth!);
        const sub = await payOrder({ order, wallet, checkout, relayer });
        const id = sub.id ?? orderId(order, checkout);
        this.#txUrl = sub.explorer || `${this.getAttribute('explorer') ?? EXPLORER}/tx/${sub.txHash}`;
        if (demo) this.#demoNote = `Paid from the demo wallet ${shortAddr(wallet.address)}: one signature, no extension, no WBT.`;
        this.#state = 'paid'; this.#stage = sub.stage ?? 'pending'; this.#render();
        const detail: WalletPaidDetail = { orderId: id, txHash: sub.txHash, explorerUrl: this.#txUrl, payer: wallet.address, amount: this.getAttribute('amount') ?? '', ref: this.getAttribute('order-ref') ?? '' };
        this.dispatchEvent(new CustomEvent('tazor-paid', { detail, bubbles: true, composed: true }));
        this.#readySent = false;
        this.#maybeReady(id, 'sequencer', { txHash: sub.txHash });
        this.#render();
        this.#stop?.();
        this.#stop = watchOrder(id, (st) => {
          this.#stage = st;
          this.#maybeReady(id, st, { txHash: sub.txHash });
          this.#render();
          this.dispatchEvent(new CustomEvent('tazor-finality', { detail: { orderId: id, stage: st }, bubbles: true, composed: true }));
        }, { checkout, relayer });
      } catch (e) {
        this.#fail(e);
      }
    }

    async #open() {
      if (this.#wallet()) return this.#payWithWallet();
      if (this.#state === 'paid') return;
      // open the window synchronously (inside the click) so popup blockers allow it; navigate once the link is ready
      const popup = this.getAttribute('target') === 'popup';
      const w = window.open('', popup ? 'tazor-pay' : '_blank', popup ? 'popup,width=480,height=820' : undefined);
      try {
        const l = await this.link;
        if (w) w.location.href = l.url; else location.assign(l.url);
        this.#watch(l);
      } catch (e) {
        w?.close();
        this.#fail(e);
      }
    }

    #watch(l: InvoiceLink) {
      this.#state = 'waiting';
      this.#render();
      this.#stop?.();
      this.#stop = watchPayment({
        invoiceHash: l.invoiceHash, payee: l.invoice.payee, explorer: this.getAttribute('explorer') ?? DEFAULT_EXPLORER,
        onPaid: (p) => {
          this.#state = 'paid';
          this.#txUrl = p.explorerUrl;
          this.#render();
          const detail: PaidDetail = { ...p, url: l.url, id: l.id };
          this.dispatchEvent(new CustomEvent('tazor-paid', { detail, bubbles: true, composed: true }));
          // invoice links settle through the company's PaymentModule: small amounts are ready at once
          this.#maybeReady(l.id, 'sequencer', { txHash: p.txHash });
          this.#render();
        },
      });
    }

    #fail(e: unknown) {
      this.#state = 'error';
      const message = e instanceof Error ? e.message : String(e);
      this.#error = message;
      this.#render();
      this.dispatchEvent(new CustomEvent('tazor-error', { detail: { message }, bubbles: true, composed: true }));
    }

    #render() {
      const label = this.getAttribute('label') || 'Pay with Tazor';
      this.#root.innerHTML = `<style>${STYLE}</style><div class="wrap" part="container">
        <button part="button" type="button"><span class="mark" part="mark" aria-hidden="true">${this.#state === 'paid' ? '✓' : 'T'}</span><span part="label"></span></button>
        <span class="status" part="status" role="status" aria-live="polite" data-state="${this.#state}"></span></div>`;
      const button = this.#root.querySelector('button')!;
      const labelEl = this.#root.querySelector('[part="label"]')!;
      const status = this.#root.querySelector('.status')!;
      labelEl.textContent = this.#state === 'paid' ? 'Paid' : label;
      button.disabled = this.#state === 'paid' || (this.#wallet() && this.#state === 'waiting');
      button.dataset.state = this.#state;
      button.addEventListener('click', () => void this.#open());
      this.#renderDemo(this.#root.querySelector('.wrap')!);
      this.#renderDeposit(this.#root.querySelector('.wrap')!);
      if (this.#wallet()) {
        if (this.#state === 'idle') status.textContent = `${this.getAttribute('amount') ?? ''} USDT · one signature in your wallet, no gas`;
        if (this.#state === 'waiting') status.textContent = 'Sign in your wallet (no gas, no transaction from you)…';
      } else {
        this.#link?.then((l) => { if (this.#state === 'idle') status.textContent = `${l.amount} USDT on Whitechain · approve with a passkey`; }, () => undefined);
        if (this.#state === 'waiting') status.textContent = 'Waiting for payment…';
      }
      if (this.#state === 'error') status.textContent = this.#error || 'Something went wrong';
      if (this.#state === 'paid') {
        status.textContent = this.#shipNote ? `${this.#shipNote} · ` : this.#wallet() && this.#stage ? `Paid ✓ · ${STAGE_TEXT[this.#stage]} · ` : 'Paid ✓ · ';
        const a = document.createElement('a');
        a.href = this.#txUrl; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'View tx'; a.setAttribute('part', 'tx');
        status.append(a);
      }
    }
  }

  customElements.define(tag, TazorPayButton);
}
