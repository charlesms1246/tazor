// Tazor landing: the fee calculator, the story slider, the "also built" list and the entrances.
// Everything is readable without this script; it only adds the live parts and the motion.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the fee calculator: 0.5% billed monthly; SWIFT loses a 1–3% FX spread
  const amount = document.getElementById('calc-amount');
  const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const calc = () => {
    const v = Number(String(amount.value).replace(/[^0-9.]/g, ''));
    const ok = Number.isFinite(v) && v > 0;
    document.getElementById('calc-arrives').textContent = ok ? fmt(v) : '—';
    document.getElementById('calc-fee').textContent = ok ? fmt(v * 0.005) : '—';
    document.getElementById('calc-swift').textContent = ok ? `${fmt(v * 0.01)}–${fmt(v * 0.03)}` : '—';
  };
  amount?.addEventListener('input', calc);
  calc();

  // ---- the story: one slider drives the clause and the exhibit
  const STAGES = [
    { clause: 'Your customer pays without gas', sentence: "One signature in any wallet that holds USDT. They hold no WBT; Tazor's relayer pays the gas. The signature names this merchant, order and amount, so nobody can redirect it." },
    { clause: 'You refund in one click', sentence: 'The merchant signs the refund, also without gas. The contract sends it only to the customer who paid, and never more than they paid.' },
    { clause: 'Your accountant gets the export', sentence: 'Every payment, refund and subscription charge as a dated CSV row with gross, refund and net, each linked to its transaction.' },
  ];
  const range = document.getElementById('stage-range');
  const clause = document.querySelector('.stage-clause');
  const sentence = document.getElementById('stage-sentence');
  const names = [...document.querySelectorAll('.stage-names li')];
  const exhibits = [...document.querySelectorAll('.stage-exhibit .exhibit')];
  const showStage = (i) => {
    const s = STAGES[i];
    const swap = () => {
      clause.textContent = s.clause;
      sentence.textContent = s.sentence;
      clause.style.opacity = '1'; sentence.style.opacity = '1';
    };
    if (reduced) swap(); else { clause.style.opacity = '0'; sentence.style.opacity = '0'; setTimeout(swap, 200); }
    exhibits.forEach((e) => {
      const on = Number(e.dataset.stage) === i;
      e.hidden = !on;
      if (on && !reduced) { e.classList.remove('swap'); void e.offsetWidth; e.classList.add('swap'); }
    });
    names.forEach((n) => n.classList.toggle('on', Number(n.dataset.i) === i));
  };
  range?.addEventListener('input', () => showStage(Number(range.value)));
  names.forEach((n) => n.addEventListener('click', () => { range.value = n.dataset.i; showStage(Number(n.dataset.i)); }));

  // ---- also built: the active item opens its description and lights its exhibit
  const items = [...document.querySelectorAll('.also-item')];
  const figs = [...document.querySelectorAll('.also-ex')];
  const activate = (i) => {
    items.forEach((b) => {
      const on = Number(b.dataset.i) === i;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
      b.nextElementSibling.hidden = !on;
    });
    figs.forEach((f) => {
      const on = Number(f.dataset.i) === i;
      f.hidden = !on;
      if (on && !reduced) { f.classList.remove('swap'); void f.offsetWidth; f.classList.add('swap'); }
    });
  };
  items.forEach((b) => {
    b.addEventListener('click', () => activate(Number(b.dataset.i)));
    b.addEventListener('mouseenter', () => activate(Number(b.dataset.i)));
    b.addEventListener('focus', () => activate(Number(b.dataset.i)));
  });

  // ---- entrances: each section's parts rise in turn, once
  const groups = [
    ['.stage-text > *', '.stage-exhibit', '.stage-control'],
    ['.board .tile'],
    ['.code-text > *', '.code'],
    ['.who-text > *', '.compare'],
    ['.menu > h2', '.menu-group'],
    ['.trust h2', '.trust-list li'],
    ['.also-list h2', '.also-list li', '.also-figure'],
    ['.close-line', '.close .actions'],
  ];
  const targets = [];
  for (const g of groups) {
    let i = 0;
    for (const sel of g) for (const el of document.querySelectorAll(sel)) { el.classList.add('reveal'); el.style.setProperty('--i', String(i++)); targets.push(el); }
  }
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach((t) => io.observe(t));
  } else targets.forEach((t) => t.classList.add('in'));

  // the hero exhibit drifts slowly; the headline rises after first paint
  document.querySelector('.calc')?.classList.add('drift');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('ready')));
})();
