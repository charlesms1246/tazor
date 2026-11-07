// <tazor-merchant-orders>: the merchant side as a drop-in. One tag lists the merchant's orders straight from Whitechain,
// refunds part or all of an order with one signature (no gas), and downloads the accountant's CSV.
//
//   <tazor-merchant-orders merchant="0x…" wallet="browser"></tazor-merchant-orders>
//
// wallet="browser" signs refunds with the page's wallet (EIP-1193); wallet="demo" with a testnet wallet kept in this
// browser (demo-key names its storage). Events: 'tazor-refunded' {orderId, amount, txHash}.
import { merchantHistory, historyCsv, refundOrder, walletSigner, EXPLORER, type HistoryRow, type Signer, type Eip1193 } from './checkout.ts';
import { demoWallet } from './demo-wallet.ts';

export const MERCHANT_ATTRIBUTES = ['merchant', 'wallet', 'demo-key', 'relayer', 'checkout', 'refresh'] as const;

const STYLE = `
:host { display: block; font: inherit; color: inherit; }
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.note { font-size: 13px; opacity: 0.75; }
table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 500; opacity: 0.7; padding: 6px 4px; border-bottom: 2px solid rgba(10, 11, 31, 0.08); }
td { padding: 8px 4px; border-bottom: 1px solid rgba(10, 11, 31, 0.06); vertical-align: middle; }
.num { text-align: right; }
.mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12.5px; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: rgba(10, 11, 31, 0.06); }
.pill.paid { background: #ddf8ee; color: #0b7350; }
button { font: inherit; font-size: 13px; min-height: 32px; padding: 0 10px; border-radius: 10px; border: 1px solid #c7d0dc; background: #fff; color: #07081e; cursor: pointer; }
button:hover { background: #f3f6fb; }
button[disabled] { opacity: 0.6; cursor: default; }
button.primary { background: #0066ff; border-color: #0066ff; color: #fff; }
a { color: #0052cc; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.empty { padding: 12px 4px; opacity: 0.7; font-size: 14px; }
@media (max-width: 520px) { .who { display: none; } }
`;

const usdt = (v: bigint) => { const s = v.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6).replace(/0{1,4}$/, '')}`; };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => { const x = document.createElement(tag); if (text) x.textContent = text; if (cls) x.className = cls; return x; };

/** Registers <tazor-merchant-orders>. Safe to call twice; a no-op outside the browser. */
export function defineTazorMerchantOrders(tag = 'tazor-merchant-orders'): void {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;

  class TazorMerchantOrders extends HTMLElement {
    static observedAttributes = [...MERCHANT_ATTRIBUTES];
    #root = this.attachShadow({ mode: 'open' });
    #rows: HistoryRow[] = [];
    #note = '';
    #timer: ReturnType<typeof setInterval> | null = null;
    #loading = false;
    #busy = 0;
    #again = false;
    #sig = '';

    connectedCallback() {
      this.#render();
      void this.refresh();
      const every = Number(this.getAttribute('refresh') ?? '10');
      if (every > 0) this.#timer = setInterval(() => void this.refresh(), every * 1000);
    }
    disconnectedCallback() { if (this.#timer) clearInterval(this.#timer); }
    attributeChangedCallback(name: string, old: string | null, value: string | null) {
      if (old === value || !this.isConnected) return;
      if (name === 'merchant') { this.#rows = []; this.#sig = ''; this.#render(); void this.refresh(); } else this.#render();
    }

    #opts() {
      return { relayer: this.getAttribute('relayer') || undefined, checkout: (this.getAttribute('checkout') || undefined) as `0x${string}` | undefined };
    }

    #for = '';
    /** Re-reads the merchant's orders from Whitechain. Results for a merchant that is no longer selected are dropped. */
    async refresh(): Promise<void> {
      const merchant = (this.getAttribute('merchant') ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(merchant)) { this.#rows = []; this.#for = ''; return this.#render(); }
      if (this.#loading) { this.#again = true; return; }
      this.#loading = true;
      let changed = this.#for !== merchant;
      try {
        const rows = await merchantHistory(merchant as `0x${string}`, this.#opts());
        if ((this.getAttribute('merchant') ?? '').toLowerCase() !== merchant) { changed = false; this.#again = true; return; }
        const sig = rows.map((r) => r.tx).join(',');
        changed = changed || sig !== this.#sig;
        this.#rows = rows; this.#sig = sig; this.#for = merchant;
        if (this.#note.startsWith('Could not read')) { this.#note = ''; changed = true; }
      } catch (e) { this.#note = `Could not read Whitechain: ${e instanceof Error ? e.message : String(e)}`; changed = true; }
      finally {
        this.#loading = false;
        // never redraw under a click in progress, and only when something changed
        if (changed && this.#busy === 0) this.#render();
        if (this.#again) { this.#again = false; void this.refresh(); }
      }
    }

    /** The demo wallet signs without asking; the browser wallet is asked only when a refund is clicked. */
    #demoSigner(): Signer | null {
      return this.getAttribute('wallet') === 'demo' ? demoWallet(this.getAttribute('demo-key') || 'tazor.demo-wallet.v1') : null;
    }
    #canRefund(): boolean {
      const merchant = (this.getAttribute('merchant') ?? '').toLowerCase();
      const demo = this.#demoSigner();
      if (demo) return demo.address.toLowerCase() === merchant;
      return this.getAttribute('wallet') === 'browser' && !!(globalThis as { ethereum?: unknown }).ethereum;
    }
    async #signer(): Promise<Signer> {
      const demo = this.#demoSigner();
      if (demo) return demo;
      const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
      if (!eth) throw new Error('No browser wallet found.');
      const w = await walletSigner(eth);
      if (w.address.toLowerCase() !== (this.getAttribute('merchant') ?? '').toLowerCase()) throw new Error(`Connect the merchant's wallet (${short(this.getAttribute('merchant') ?? '')}) to refund.`);
      return w;
    }

    #exportCsv() {
      const blob = new Blob([historyCsv(this.#rows)], { type: 'text/csv' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tazor-orders-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    }

    #render() {
      const paid = this.#rows.filter((r): r is Extract<HistoryRow, { kind: 'paid' }> => r.kind === 'paid');
      const refundedOf = (id: string) => this.#rows.filter((r) => r.kind === 'refunded' && r.id === id).reduce((s, r) => s + (r as { amount: bigint }).amount, 0n);
      const root = this.#root;
      root.innerHTML = `<style>${STYLE}</style>`;
      const top = el('div', '', 'top');
      top.setAttribute('part', 'toolbar');
      top.append(el('span', paid.length ? `${paid.length} order${paid.length === 1 ? '' : 's'}, read from Whitechain` : 'Read from Whitechain', 'note'));
      const csv = el('button', 'Accountant export (CSV)');
      csv.type = 'button'; csv.setAttribute('part', 'export'); csv.dataset.testid = 'tmo-export';
      csv.disabled = this.#rows.length === 0;
      csv.addEventListener('click', () => this.#exportCsv());
      top.append(csv);
      root.append(top);
      if (!paid.length) { root.append(el('p', this.#loading ? 'Loading…' : 'No orders yet.', 'empty')); }
      else {
        const table = el('table');
        table.setAttribute('part', 'table');
        table.innerHTML = '<thead><tr><th>Order</th><th class="who">Customer</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead>';
        const body = el('tbody');
        const canRefund = this.#canRefund() && this.#for === (this.getAttribute('merchant') ?? '').toLowerCase();
        for (const o of paid.slice().reverse()) {
          const back = refundedOf(o.id);
          const left = o.amount - back;
          const tr = el('tr');
          tr.dataset.order = o.id;
          const status = el('td');
          status.append(el('span', back === 0n ? 'Paid' : left === 0n ? 'Refunded' : `Refunded ${usdt(back)}`, `pill ${back === 0n ? 'paid' : ''}`), document.createTextNode(' '));
          const tx = el('a', 'tx'); tx.href = `${EXPLORER}/tx/${o.tx}`; tx.target = '_blank'; tx.rel = 'noreferrer'; status.append(tx);
          const act = el('td'); const box = el('div', '', 'actions'); act.append(box);
          if (canRefund && left > 0n) {
            const part = left > o.amount / 4n ? o.amount / 4n : left;
            const mk = (label: string, amount: bigint, primary = false) => {
              const b = el('button', label, primary ? 'primary' : ''); b.type = 'button'; b.dataset.testid = 'tmo-refund';
              b.addEventListener('click', async () => {
                b.disabled = true; b.textContent = 'Signing…';
                this.#busy++;
                try {
                  const r = await refundOrder({ id: o.id, amount, wallet: await this.#signer(), ...this.#opts() });
                  b.textContent = 'Refund sent';
                  this.dispatchEvent(new CustomEvent('tazor-refunded', { detail: { orderId: o.id, amount: amount.toString(), txHash: r.txHash }, bubbles: true, composed: true }));
                  this.#busy--;
                  setTimeout(() => void this.refresh(), 3000);
                } catch (e) { this.#busy--; b.disabled = false; b.textContent = label; this.#note = e instanceof Error ? e.message : String(e); this.#render(); }
              });
              return b;
            };
            box.append(mk(`Refund ${usdt(part)}`, part, true));
            if (left > part) box.append(mk('Refund all', left));
          }
          tr.append(el('td', short(o.id), 'mono'), el('td', short(o.payer), 'mono who'), el('td', `${usdt(o.amount)} USDT`, 'num'), status, act);
          body.append(tr);
        }
        table.append(body);
        root.append(table);
      }
      if (this.#note) root.append(el('p', this.#note, 'note'));
    }
  }

  customElements.define(tag, TazorMerchantOrders);
}
