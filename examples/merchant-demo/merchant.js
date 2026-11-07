// Optional parts of the demo (not in the integration count): the subscription plan, and a merchant dashboard that reads
// orders, refunds and subscriptions straight from Whitechain, refunds with one signature, verifies webhooks and exports CSV.
const T = window.TazorPay;
const button = document.querySelector('tazor-pay-button');
const orders = document.querySelector('tazor-merchant-orders');
const $ = (s) => document.querySelector(s);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdt = (v) => { const s = BigInt(v).toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6).replace(/0{1,4}$/, '')}`; };
const txLink = (h, text = 'View transaction') => { const a = document.createElement('a'); a.href = `${T.checkout.EXPLORER}/tx/${h}`; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = text; return a; };
const el = (tag, text, cls) => { const x = document.createElement(tag); if (text !== undefined) x.textContent = text; if (cls) x.className = cls; return x; };

// The demo's webhook test secret. It is public on purpose; a real shop keeps its secret on its server.
const DEMO_WEBHOOK_SECRET = 'whsec_tazor_demo_test';
const PLAN = { amount: 100000n, period: 604800, cycles: 4, ref: T.orderRef('weekly-freight-lane') };

let merchantWallet = null;
const merchant = () => button.getAttribute('merchant');
const SAVED = 'bluejay.merchant.v1';
if (localStorage.getItem(SAVED)) { button.setAttribute('merchant', localStorage.getItem(SAVED)); orders.setAttribute('merchant', localStorage.getItem(SAVED)); }
$('#merchant-addr').textContent = short(merchant());
$('#merchant-addr').title = merchant();

// ---- customer: order paid → watch for a refund (an on-chain record anyone can check)
let paidOrderId = null;
button.addEventListener('tazor-paid', (e) => { paidOrderId = e.detail.orderId; refresh(); });

// ---- customer: subscription
const subKey = 'bluejay.sub.v1';
async function customerWallet() {
  if (!window.ethereum) throw new Error('No browser wallet found.');
  return T.walletSigner(window.ethereum);
}
function showSub(text, tx) {
  const s = $('#sub-status');
  s.replaceChildren(el('span', `${text} `));
  if (tx) s.append(txLink(tx));
}
$('#sub-start').addEventListener('click', async () => {
  try {
    const wallet = await customerWallet();
    showSub('Sign twice in your wallet: week 1, then the permit for weeks 2–4 (no gas).');
    const plan = { ...PLAN, merchant: merchant() };
    const r = await T.subscribe({ plan, wallet });
    localStorage.setItem(subKey, JSON.stringify({ id: r.id || T.subId(plan, wallet.address, T.checkout.CHECKOUT), payer: wallet.address }));
    showSub('Subscribed: week 1 paid, 3 more weekly pulls of 0.10 USDT.', r.txHash);
    $('#sub-cancel').hidden = false;
    refresh();
  } catch (e) { showSub(e.message); }
});
$('#sub-cancel').addEventListener('click', async () => {
  try {
    const s = JSON.parse(localStorage.getItem(subKey) || 'null');
    if (!s) return;
    const wallet = await customerWallet();
    showSub('Sign once to cancel (no gas)…');
    const r = await T.cancelSubscription({ id: s.id, wallet });
    showSub('Cancelled: no more pulls.', r.txHash);
    $('#sub-cancel').hidden = true;
    refresh();
  } catch (e) { showSub(e.message); }
});
if (localStorage.getItem(subKey)) $('#sub-cancel').hidden = false;

// ---- merchant: wallet, orders, refunds
const DEMO_MERCHANT = 'bluejay.demo-merchant.v1';
function useMerchant(wallet, note, kind) {
  merchantWallet = wallet;
  button.setAttribute('merchant', wallet.address);
  orders.setAttribute('wallet', kind);
  if (kind === 'demo') orders.setAttribute('demo-key', DEMO_MERCHANT);
  orders.setAttribute('merchant', wallet.address);
  localStorage.setItem(SAVED, wallet.address);
  $('#merchant-addr').textContent = short(wallet.address);
  $('#merchant-addr').title = wallet.address;
  $('#merchant-note').textContent = note;
  refresh();
}
$('#merchant-demo').addEventListener('click', () => {
  useMerchant(T.demoWallet(DEMO_MERCHANT), 'Demo merchant wallet (kept in this browser, testnet only). Checkouts on the left now pay it, and it refunds here with one signature: no extension, no gas.', 'demo');
});
if (localStorage.getItem(DEMO_MERCHANT) && localStorage.getItem(SAVED) === T.demoWallet(DEMO_MERCHANT).address) { merchantWallet = T.demoWallet(DEMO_MERCHANT); orders.setAttribute('wallet', 'demo'); orders.setAttribute('demo-key', DEMO_MERCHANT); }
$('#merchant-connect').addEventListener('click', async () => {
  try {
    merchantWallet = await T.walletSigner(window.ethereum);
    button.setAttribute('merchant', merchantWallet.address);
    orders.setAttribute('wallet', 'browser');
    orders.setAttribute('merchant', merchantWallet.address);
    localStorage.setItem(SAVED, merchantWallet.address);
    $('#merchant-addr').textContent = short(merchantWallet.address);
    $('#merchant-addr').title = merchantWallet.address;
    $('#merchant-note').textContent = 'Checkouts on the left now pay this wallet, and you can refund them here.';
    refresh();
  } catch (e) { $('#merchant-note').textContent = e.message || String(e); }
});

let history = [];
async function refresh() {
  try { history = await T.merchantHistory(merchant()); } catch (e) { $('#merchant-note').textContent = `Could not read Whitechain: ${e.message}`; return; }
  renderSubs();
  renderCustomerRefund();
}

function renderSubs() {
  const subs = history.filter((r) => r.kind === 'subscribed');
  $('#subs tbody').replaceChildren(...subs.slice().reverse().map((s) => {
    const charges = 1 + history.filter((r) => r.kind === 'charged' && r.id === s.id).length;
    const cancelled = history.some((r) => r.kind === 'cancelled' && r.id === s.id);
    const tr = document.createElement('tr');
    tr.append(el('td', short(s.payer), 'mono'), el('td', `${usdt(s.amount)} USDT × ${s.cycles}, weekly`), el('td', cancelled ? `Cancelled after ${charges}` : `${charges} of ${s.cycles} paid`));
    return tr;
  }));
}

function renderCustomerRefund() {
  if (!paidOrderId) return;
  const refunds = history.filter((r) => r.kind === 'refunded' && r.id === paidOrderId);
  if (!refunds.length) return;
  const p = $('#order-refund');
  const total = refunds.reduce((s, r) => s + r.amount, 0n);
  p.replaceChildren(el('span', `Refunded ${usdt(total)} USDT to your wallet · `), txLink(refunds.at(-1).tx, 'View the refund on chain'));
  p.hidden = false;
  $('#order-status').textContent = 'Refunded';
}

// ---- merchant: webhook deliveries, each verified in the page
async function hooks() {
  try {
    const res = await fetch(`${T.checkout.RELAYER_URL}/webhooks/recent?merchant=${merchant()}`);
    const j = await res.json();
    const list = Array.isArray(j) ? j : j.deliveries || [];
    const items = await Promise.all(list.slice(0, 12).map(async (d) => {
      const raw = d.rawBody ?? JSON.stringify(d.body ?? d);
      const v = await T.verifyWebhook(raw, d.signature ?? d.header ?? null, DEMO_WEBHOOK_SECRET, 7 * 24 * 3600);
      const li = el('li');
      const ev = v.ok ? v.event : (() => { try { return JSON.parse(raw); } catch { return {}; } })();
      li.append(el('b', ev.type || d.type || 'event'), el('span', ` ${new Date((ev.created || d.created || 0) * 1000).toLocaleTimeString()} `), el('span', v.ok ? '✓ signature verified' : `✗ ${v.reason}`, v.ok ? 'ok' : 'bad'));
      if (ev.txHash) { li.append(document.createTextNode(' · ')); li.append(txLink(ev.txHash, 'tx')); }
      return li;
    }));
    $('#hooks').replaceChildren(...(items.length ? items : [el('li', 'No deliveries yet.', 'muted')]));
  } catch { $('#hooks').replaceChildren(el('li', 'Webhook log unavailable right now.', 'muted')); }
}

refresh();
hooks();
setInterval(refresh, 10000);
setInterval(hooks, 10000);

// the merchant tag refunded an order: refresh the customer's side too
orders.addEventListener('tazor-refunded', () => setTimeout(refresh, 3000));
// a new payment shows in the merchant's orders straight away
button.addEventListener('tazor-paid', () => setTimeout(() => orders.refresh?.(), 2500));
