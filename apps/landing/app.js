// Tazor landing: the live parts. The fee calculator, the pay → refund → export slider and the "also built" list.
// Everything is readable without this script.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the fee calculator: 0.5% billed monthly; SWIFT loses a 1–3% FX spread
  const amount = document.getElementById('calc-amount');
  const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const out = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const calc = () => {
    const v = Number(String(amount.value).replace(/[^0-9.]/g, ''));
    const ok = Number.isFinite(v) && v > 0;
    out('calc-arrives', ok ? fmt(v) : '—');
    out('calc-fee', ok ? fmt(v * 0.005) : '—');
    out('calc-swift', ok ? `${fmt(v * 0.01)}–${fmt(v * 0.03)}` : '—');
  };
  if (amount) { amount.addEventListener('input', calc); calc(); }

  // ---- the story: one slider drives the clause, the sentence and the exhibit
  const STAGES = [
    { clause: 'Your customer pays without gas', sentence: "One signature in any wallet that holds USDT. They hold no WBT; Tazor's relayer pays the gas. The signature names this merchant, order and amount, so nobody can redirect it." },
    { clause: 'You refund in one click', sentence: 'The merchant signs the refund, also without gas. The contract sends it only to the customer who paid, and never more than they paid.' },
    { clause: 'Your accountant gets the export', sentence: 'Every payment, refund and subscription charge as a dated CSV row with gross, refund and net, each linked to its transaction.' },
  ];
  const range = document.getElementById('stage-range');
  const clause = document.getElementById('stage-title');
  const sentence = document.getElementById('stage-sentence');
  const names = [...document.querySelectorAll('.stage-names li[data-i]')];
  const exhibits = [...document.querySelectorAll('.exhibits .exhibit[data-stage]')];
  let timer = 0;
  const show = (i) => {
    const s = STAGES[i];
    const swap = () => { clause.textContent = s.clause; sentence.textContent = s.sentence; clause.style.opacity = sentence.style.opacity = '1'; };
    clearTimeout(timer);
    if (calm) swap(); else { clause.style.opacity = sentence.style.opacity = '0'; timer = setTimeout(swap, 200); }
    exhibits.forEach((e) => {
      const on = Number(e.dataset.stage) === i;
      e.hidden = !on;
      if (on && !calm) { e.classList.remove('swap'); void e.offsetWidth; e.classList.add('swap'); }
    });
    names.forEach((n) => n.classList.toggle('on', Number(n.dataset.i) === i));
  };
  if (range && clause && sentence) {
    range.addEventListener('input', () => show(Number(range.value)));
    names.forEach((n) => n.addEventListener('click', () => { range.value = n.dataset.i; show(Number(n.dataset.i)); }));
  }

  // ---- also built: one item open at a time
  const items = [...document.querySelectorAll('.also-item')];
  const open = (b) => items.forEach((x) => {
    const on = x === b;
    x.classList.toggle('on', on);
    x.setAttribute('aria-expanded', String(on));
    const d = x.nextElementSibling;
    if (d?.classList.contains('also-desc')) d.hidden = !on;
  });
  items.forEach((b) => b.addEventListener('click', () => open(b)));
})();
