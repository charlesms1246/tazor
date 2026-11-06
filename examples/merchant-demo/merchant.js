// Merchant dashboard (optional, not part of the integration count): lists this browser's checkouts and watches each one
// on Whitechain with TazorPay.watchPayment, so a payment made on the customer's phone shows up here too.
const KEY = 'bluejay.orders.v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (list) => localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
const watching = new Set();

function render() {
  const list = load();
  const body = document.querySelector('#orders tbody');
  body.replaceChildren(...list.map((o) => {
    const tr = document.createElement('tr');
    const status = o.txUrl ? `<span class="pill paid">Paid</span> <a href="${o.txUrl}" target="_blank" rel="noreferrer">tx</a>` : '<span class="pill">Awaiting payment</span>';
    tr.innerHTML = `<td><span class="mono">${o.id}</span><span class="sub mono" title="${o.invoiceHash}">${o.invoiceHash.slice(0, 10)}…</span></td><td class="num">${o.amount} <span class="unit">USDT</span></td><td>${status}</td>`;
    return tr;
  }));
  document.querySelector('#orders-empty').hidden = list.length > 0;
  for (const o of list) if (!o.txUrl && !watching.has(o.invoiceHash)) watch(o);
}

function watch(o) {
  watching.add(o.invoiceHash);
  window.TazorPay.watchPayment({
    invoiceHash: o.invoiceHash, payee: o.payee, intervalMs: 6000,
    onPaid: (p) => { save(load().map((x) => (x.invoiceHash === o.invoiceHash ? { ...x, txUrl: p.explorerUrl } : x))); render(); },
  });
}

const button = document.querySelector('tazor-pay-button');
const onLink = ({ id, invoiceHash, amount, invoice }) => {
  document.querySelector('#order-no').textContent = id;
  if (!load().some((o) => o.invoiceHash === invoiceHash)) save([{ id, invoiceHash, amount, payee: invoice.payee }, ...load()]);
  render();
};
// the element's link promise covers a link created before this script ran; the event covers later ones
customElements.whenDefined('tazor-pay-button').then(() => button.link).then(onLink, () => undefined);
button.addEventListener('tazor-link', (e) => onLink(e.detail));
button.addEventListener('tazor-paid', (e) => {
  save(load().map((o) => (o.invoiceHash === e.detail.invoiceHash ? { ...o, txUrl: e.detail.explorerUrl } : o)));
  render();
});
render();
