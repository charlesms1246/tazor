// <tazor-pay-button>: a framework-free custom element that creates a Tazor payment link, opens it, and waits for payment.
import { createInvoiceLink, DEFAULT_EXPLORER, watchPayment, type InvoiceInput, type InvoiceLink, type LineInput, type Payment } from './core.ts';

export const ATTRIBUTES = [
  'supplier-name', 'supplier-account', 'payee', 'buyer', 'amount', 'lines', 'memo', 'due', 'app-url', 'label',
  'invoice-id', 'tax-rate', 'tax-label', 'explorer', 'target',
] as const;

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
`;

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
      this.link.then(() => this.#render(), (e) => this.#fail(e));
    }
    disconnectedCallback() { this.#stop?.(); }
    attributeChangedCallback(name: string, old: string | null, value: string | null) {
      if (old === value || this.#state === 'paid' || name === 'label') return void (this.isConnected && this.#render());
      this.#link = null;
      if (this.isConnected) this.link.then(() => this.#render(), (e) => this.#fail(e));
    }

    async #open() {
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
      button.disabled = this.#state === 'paid';
      button.dataset.state = this.#state;
      button.addEventListener('click', () => void this.#open());
      this.#link?.then((l) => { if (this.#state === 'idle') status.textContent = `${l.amount} USDT on Whitechain · approve with a passkey`; }, () => undefined);
      if (this.#state === 'waiting') status.textContent = 'Waiting for payment…';
      if (this.#state === 'error') status.textContent = this.#error || 'Something went wrong';
      if (this.#state === 'paid') {
        status.textContent = 'Paid ✓ · ';
        const a = document.createElement('a');
        a.href = this.#txUrl; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'View tx'; a.setAttribute('part', 'tx');
        status.append(a);
      }
    }
  }

  customElements.define(tag, TazorPayButton);
}
