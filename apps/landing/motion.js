// Tazor landing: the choreography (GSAP + ScrollTrigger 3.15.0). The intro counts to 100% and opens the page with a
// shockwave; on a desktop the hero, about and engine scenes play on one pinned stage, rain lifting into the cards
// and a wave of pixels carrying one scene into the next; elsewhere sections rise as they arrive. Ported from Garant.
(() => {
  const root = document.documentElement;
  const TZ = window.TZ || { field: {}, rain: {}, calm: true };
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const loaded = () => dispatchEvent(new Event('tz:loaded'));

  // ---- the rail: the pinned stage reports its scene; the sections below report themselves
  const ticks = $$('.rail a[data-rail]');
  const label = $('.rail-label');
  let current = -1;
  function chapter(i) {
    if (i === current || !ticks[i]) return;
    current = i;
    ticks.forEach((t, k) => {
      if (k === i) t.setAttribute('aria-current', 'step'); else t.removeAttribute('aria-current');
      t.dataset.past = String(k < i);
    });
    if (label) label.textContent = ticks[i].textContent.trim();
  }
  addEventListener('tz:chapter', (e) => chapter(e.detail));
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) chapter(Number(e.target.dataset.chapter));
  }, { rootMargin: '-45% 0px -45% 0px' });
  $$('[data-chapter]').forEach((s) => io.observe(s));
  chapter(0);

  const { gsap, ScrollTrigger } = window;
  if (calm || !gsap || !ScrollTrigger) {
    // no motion library, or the visitor asked for less: everything is shown as it stands
    delete root.dataset.motion;
    if (TZ.field) TZ.field.hidden = false;
    loaded();
    return;
  }
  gsap.registerPlugin(ScrollTrigger);
  const { field, rain, waveFront, waveWob } = TZ;

  // ---- the intro: count to 100%, then the shockwave opens the veil
  const loader = $('[data-loader]');
  const veil = $('.loader-veil');
  const count = $('.loader-count');
  const floor = $('[data-floor]');
  const word = $('[data-hero-word]');
  const ui = $$('#top [data-ui]');
  gsap.set(floor, { scaleX: 0 });
  gsap.set(word, { autoAlpha: 0, y: 60 });
  gsap.set(ui, { autoAlpha: 0, y: 18 });

  function entrance() {
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.to(floor, { scaleX: 1, duration: 1.2, ease: 'expo.out' }, 0)
      .to(word, { autoAlpha: 1, y: 0, duration: 1.1 }, 0.15)
      .to(ui, { autoAlpha: 1, y: 0, duration: 0.8, stagger: 0.08 }, 0.5);
  }
  function open() {
    const n = { v: 0 };
    const tl = gsap.timeline();
    tl.to(n, { v: 100, duration: 2.3, ease: 'power2.inOut', onUpdate: () => { count.textContent = `${Math.round(n.v)}%`; } })
      .to(count, { autoAlpha: 0, scale: 0.92, duration: 0.3 })
      .add(() => { field.hidden = false; field.shock.on = true; field.shock.r = 0; })
      .to(field.shock, {
        r: Math.hypot(innerWidth, innerHeight) / 2 + 160, duration: 1.2, ease: 'power2.in',
        onUpdate: () => veil.style.setProperty('--r', `${Math.max(0, field.shock.r - 40)}px`),
      })
      .add(() => { field.shock.on = false; loader.remove(); loaded(); entrance(); });
  }
  if (loader) open(); else { field.hidden = false; loaded(); entrance(); }

  // ---- the stage (desktop): hero → about → one engine, pinned and scrubbed
  const story = $('.story');
  const intro = $('[data-layer="intro"]');
  const about = $('[data-layer="about"]');
  const engine = $('[data-layer="engine"]');
  const U = { hold: 0.5, liftLen: 2.4, w1: 4.6, wave: 2.0, end: 8.4 };
  const P = 1700; // the layers' perspective

  // a card on an arc: sideways along the circle, pushed back with distance, turned to face the middle
  function onArc(t, R) { return { x: R * Math.sin(t), z: -R * (1 - Math.cos(t)), rotationY: (-t * 180) / Math.PI }; }

  const mm = gsap.matchMedia();
  mm.add('(min-width: 1024px)', () => {
    story.dataset.mode = 'stage';
    TZ.rainResize?.();
    const W = innerWidth;
    const aCards = $$('[data-arc="about"] > [data-card]');
    const eCards = $$('[data-arc="engine"] > [data-card]');
    const objs = $$('[data-arc="engine"] > [data-obj]');

    // the about fan
    const A = (26 * Math.PI) / 180, Ra = W * 0.32;
    const aPose = aCards.map((_, i) => ({ ...onArc((i - 1) * A, Ra), y: i === 1 ? -18 : 12 }));
    // the engine arc, cards spaced by their widths
    const Re = W * 1.1, gap = W * 0.016, LIFT = [10, -34, 16, -34, 10];
    const widths = eCards.map((c) => c.getBoundingClientRect().width || W * 0.15);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
    let run = -total / 2;
    const ePose = eCards.map((_, i) => { const mid = run + widths[i] / 2; run += widths[i] + gap; return { ...onArc(mid / Re, Re), y: LIFT[i] }; });
    const oPose = ePose.map((p, i) => ({ x: p.x, y: p.y - 160 - 44, z: p.z + 60, rotationY: p.rotationY, rotationZ: [-12, 8, -6, 10, -8][i] }));

    gsap.set([...aCards, ...eCards, ...objs], { xPercent: -50, yPercent: -50, transformPerspective: 0 });
    aCards.forEach((c, i) => gsap.set(c, aPose[i]));
    eCards.forEach((c, i) => gsap.set(c, ePose[i]));
    objs.forEach((o, i) => gsap.set(o, oPose[i]));
    gsap.set(about, { autoAlpha: 1 });
    gsap.set($$('[data-part]', about), { autoAlpha: 0, y: 30 });
    gsap.set(aCards, { autoAlpha: 0 });
    gsap.set(engine, { autoAlpha: 0 });

    // where the rain lands: each about card's footprint inside the hero, perspective included
    function targets() {
      const host = intro.getBoundingClientRect();
      const arc = $('[data-arc="about"]').getBoundingClientRect();
      const cw = aCards[0].offsetWidth, ch = aCards[0].offsetHeight;
      rain.targets = aPose.map((p) => {
        const s = P / (P - p.z), w = cw * s * Math.cos((p.rotationY * Math.PI) / 180), h = ch * s;
        const cx = arc.left + arc.width / 2 + p.x * s - host.left, cy = arc.top + arc.height / 2 + p.y * s - host.top;
        return { x: cx - w / 2, y: cy - h / 2, w, h };
      });
    }
    targets();

    // the wave's edge, as a clip: one side shows the scene leaving, the other the scene arriving
    const sw = { p: 0 };
    function edge(side) {
      const w = story.clientWidth, h = story.clientHeight, T = performance.now() / 1000;
      const f = waveFront(sw.p, w), pts = [];
      for (let y = 0; y <= h + 40; y += 40) pts.push(`${(f + waveWob(y, T)).toFixed(1)}px ${y}px`);
      return side === 'leave'
        ? `polygon(${pts.join(',')}, ${w + 60}px ${h + 40}px, ${w + 60}px 0px)`
        : `polygon(-60px 0px, ${pts.join(',')}, -60px ${h + 40}px)`;
    }
    function wave() {
      const p = sw.p;
      field.wave.mode = 'x';
      field.wave.p = p;
      field.wave.on = p > 0 && p < 1;
      about.style.clipPath = p > 0 && p < 1 ? edge('leave') : '';
      engine.style.clipPath = p > 0 && p < 1 ? edge('arrive') : '';
    }

    const tl = gsap.timeline({ defaults: { ease: 'none' } });
    const at = (u) => U.hold + u;
    // the hero leaves: copy first, then the pooled rain lifts into the cards, then the word and the floor
    tl.to(['[data-hero-fade="sub"]', '[data-hero-fade="bar"]'], { autoAlpha: 0, y: -40, duration: 0.6, ease: 'power2.in' }, at(0))
      .fromTo(rain, { lift: 0 }, { lift: 1.15, duration: U.liftLen, onStart: targets }, at(0.2))
      .to('[data-hero-fade="word"]', { autoAlpha: 0, y: -50, scale: 0.94, duration: 0.8, ease: 'power2.in' }, at(0.4))
      .to(floor, { scaleX: 0, duration: 0.9, ease: 'power2.in' }, at(0.9))
      .to('.floor-labels', { autoAlpha: 0, duration: 0.5 }, at(0.9))
      .set(intro, { pointerEvents: 'none' }, at(0.9))
      .to($$('[data-part]', about), { autoAlpha: 1, y: 0, duration: 0.8, ease: 'power2.out' }, at(1.2))
      .fromTo(aCards, { autoAlpha: 0, z: (i) => aPose[i].z - 60 }, { autoAlpha: 1, z: (i) => aPose[i].z, duration: 0.7, stagger: 0.12, ease: 'power2.out' }, at(U.liftLen - 0.5))
      // about → engine on a wave of pixels
      .set(engine, { autoAlpha: 1 }, U.w1)
      .to(sw, { p: 1, duration: U.wave, onUpdate: wave }, U.w1)
      .to(aCards, { z: (i) => aPose[i].z + 420, rotationX: -18, autoAlpha: 0, duration: U.wave * 0.7, stagger: 0.1, ease: 'power2.in' }, U.w1 + 0.2)
      .to($$('[data-part]', about), { autoAlpha: 0, x: -60, duration: U.wave * 0.5, ease: 'power2.in' }, U.w1 + 0.2)
      .set(about, { autoAlpha: 0 }, U.w1 + U.wave)
      .from($$('[data-part]', engine), { autoAlpha: 0, y: 40, duration: 0.8, ease: 'power2.out' }, U.w1 + 0.3)
      .from(eCards, { autoAlpha: 0, z: (i) => ePose[i].z - 900, rotationX: 28, y: (i) => ePose[i].y + 120, duration: 1.1, stagger: 0.12, ease: 'power3.out' }, U.w1 + 0.35)
      .from(objs, { autoAlpha: 0, scale: 0.3, y: (i) => oPose[i].y - 140, duration: 0.9, stagger: 0.1, ease: 'back.out(1.6)' }, U.w1 + 0.9)
      .to({}, { duration: U.end - (U.w1 + U.wave) }); // hold the engine before the page scrolls on

    const st = ScrollTrigger.create({
      trigger: story, start: 'top top', end: `+=${U.end * 50}%`, pin: true, scrub: 1, animation: tl,
      onUpdate: () => {
        const t = tl.time();
        dispatchEvent(new CustomEvent('tz:chapter', { detail: t < U.hold + U.liftLen * 0.6 ? 0 : t < U.w1 + U.wave / 2 ? 1 : 2 }));
      },
      onRefresh: targets,
    });

    // the glyphs bob; the camera leans toward the pointer
    const bob = objs.map((o, i) => gsap.to($('.glyph-in', o), { y: -12, rotation: i % 2 ? 6 : -6, duration: 2.4 + i * 0.3, ease: 'sine.inOut', yoyo: true, repeat: -1 }));
    const cams = $$('[data-camera]', story).map((c) => ({ rx: gsap.quickTo(c, 'rotationX', { duration: 1.2, ease: 'power3' }), ry: gsap.quickTo(c, 'rotationY', { duration: 1.2, ease: 'power3' }) }));
    const lean = (e) => { const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5; cams.forEach((c) => { c.ry(nx * 6); c.rx(-ny * 4); }); };
    addEventListener('pointermove', lean, { passive: true });

    return () => {
      removeEventListener('pointermove', lean);
      bob.forEach((b) => b.kill());
      st.kill();
      about.style.clipPath = engine.style.clipPath = '';
      field.wave.on = false;
      rain.lift = 0;
      delete story.dataset.mode;
      gsap.set([...aCards, ...eCards, ...objs, about, engine, intro, ...$$('[data-part]', story), '[data-hero-fade]', ...$$('[data-camera]', story)], { clearProps: 'all' });
      gsap.set(floor, { scaleX: 1 });
      TZ.rainResize?.();
    };
  });

  // ---- phones and tablets: the story's parts rise as they arrive
  mm.add('(max-width: 1023px)', () => {
    const items = $$('#about [data-part], #about [data-card], #engine [data-part], #engine [data-card]');
    const tws = items.map((el) => gsap.from(el, { autoAlpha: 0, y: 60, rotationX: -25, transformPerspective: 900, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true } }));
    return () => tws.forEach((t) => { t.scrollTrigger?.kill(); t.progress(1).kill(); });
  });

  // ---- the sections below the stage
  $$('[data-reveal]').forEach((el) => {
    gsap.from(el, { autoAlpha: 0, y: 48, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 86%', once: true } });
  });
  const steps = $$('[data-steps] [data-step]');
  if (steps.length) {
    gsap.from(steps, {
      autoAlpha: 0, z: -260, y: 80, rotationX: -28, rotationY: (i) => (i - 1) * -22, transformOrigin: '50% 100%', duration: 1.1, stagger: 0.14, ease: 'power3.out',
      scrollTrigger: { trigger: '[data-steps]', start: 'top 82%', once: true },
    });
  }
  const foot = $('[data-foot]');
  if (foot) {
    const lean0 = matchMedia('(max-width: 720px)').matches ? 18 : 34;
    gsap.fromTo(foot, { rotationX: lean0 }, { rotationX: 8, ease: 'none', scrollTrigger: { trigger: '.foot', start: 'top bottom', end: 'bottom bottom', scrub: 1 } });
  }

  // ---- the pixel cursor and the glass's light follow the pointer (fine pointers only)
  if (matchMedia('(pointer: fine)').matches) {
    const px = document.createElement('div');
    px.className = 'px-cursor';
    px.setAttribute('aria-hidden', 'true');
    document.body.append(px);
    const qx = gsap.quickTo(px, 'x', { duration: 0.25, ease: 'power3' });
    const qy = gsap.quickTo(px, 'y', { duration: 0.25, ease: 'power3' });
    addEventListener('pointermove', (e) => {
      px.style.opacity = '1';
      qx(e.clientX - px.offsetWidth / 2); qy(e.clientY - px.offsetHeight / 2);
      px.dataset.hot = String(!!e.target.closest?.('a, button, input, label, [data-card]'));
      const g = e.target.closest?.('.glass');
      if (g) { const r = g.getBoundingClientRect(); g.style.setProperty('--mx', `${e.clientX - r.left}px`); g.style.setProperty('--my', `${e.clientY - r.top}px`); }
    }, { passive: true });
    document.addEventListener('pointerleave', () => { px.style.opacity = '0'; });
  }

  document.fonts?.ready.then(() => ScrollTrigger.refresh());
})();
