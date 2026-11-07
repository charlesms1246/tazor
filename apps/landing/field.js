// Tazor landing: the pixel space. One requestAnimationFrame loop draws the fixed pixel field (twinkle, pointer glow,
// the loader's shockwave and the scene waves) and the hero's pixel rain, which pools on the floor under the wordmark
// and later lifts into the about cards. Whitechain blue on white. Ported from Garant's pixel-field and rain-floor.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // ---- the bus: state shared with motion.js (plain fields, read once per frame)
  const field = { hidden: false, shock: { on: false, r: 0 }, wave: { on: false, mode: 'x', p: 0 } };
  const rain = { lift: 0, targets: [] };
  const waveFront = (p, size) => -300 + p * (size + 700);
  const waveWob = (v, T) => 110 * Math.sin(v * 0.0052 + T * 0.8) + 60 * Math.sin(v * 0.0143 - T * 1.3) + 150 * Math.sin(v * 0.0021 + T * 0.35 + 1.7);
  const wavePass = (coord, size) => Math.min(1, Math.max(0, (coord + 300) / (size + 700)));
  window.TZ = { field, rain, waveFront, waveWob, wavePass, calm };

  // Whitechain blue, lighter blue, deeper blue: the wave's ramp; nothing outside the blue family
  const RAMP = [[0, 102, 255], [92, 156, 255], [0, 70, 190]];
  const lerp = (a, b, t) => a + (b - a) * t;
  function ramp(t, wake) {
    const seg = Math.min(1.999, t * 2), i = Math.floor(seg), f = seg - i;
    return [0, 1, 2].map((n) => lerp(lerp(RAMP[i][n], RAMP[i + 1][n], f), 0, wake * 0.15));
  }

  // ================= the pixel field
  const fc = document.getElementById('field');
  const fx = fc.getContext('2d');
  const CELL = 12, SIZE = 7, FPS = 18;
  let cols = 0, rows = 0, base = new Float32Array(0), level = new Float32Array(0), edge = new Float32Array(0);
  let pointer = { x: -1e4, y: -1e4 };
  if (!calm && document.querySelector('[data-loader]')) field.hidden = true;

  function fieldResize() {
    const w = innerWidth, h = innerHeight;
    fc.width = w * dpr; fc.height = h * dpr; fc.style.width = `${w}px`; fc.style.height = `${h}px`;
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CELL); rows = Math.ceil(h / CELL);
    base = new Float32Array(cols * rows); level = new Float32Array(cols * rows); edge = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const dx = Math.abs(c / cols - 0.5) * 2; // denser toward the edges, so reading stays calm in the middle
      edge[i] = Math.min(1, Math.max(0.06, (dx - 0.35) / 0.65));
      base[i] = Math.random() * 0.3;
      level[i] = base[i];
    }
    fieldDraw();
  }

  function fieldDraw() {
    fx.clearRect(0, 0, cols * CELL, rows * CELL);
    if (field.hidden) return;
    const W = cols * CELL, H = rows * CELL, cx = W / 2, cy = H / 2;
    const depth = scrollY * 0.18, rowShift = Math.floor(depth / CELL), sub = depth % CELL;
    const { shock, wave } = field;
    const horizontal = wave.mode === 'x';
    const front = wave.on ? waveFront(wave.p, horizontal ? W : H) : 0;
    const T = performance.now() / 1000;
    const n = horizontal ? rows : cols;
    const wob = new Float32Array(n), lead = new Float32Array(n), tail = new Float32Array(n), ray = new Float32Array(n), hue = new Float32Array(n);
    if (wave.on) for (let k = 0; k < n; k++) {
      const v = k * CELL;
      wob[k] = waveWob(v, T);
      lead[k] = 60 + 50 * Math.sin(v * 0.011 + 2);
      tail[k] = 520 + 300 * Math.sin(v * 0.0073 + T * 0.5);
      ray[k] = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(v * 0.06 + Math.sin(v * 0.017 + T * 0.7) * 3));
      hue[k] = 0.5 + 0.5 * Math.sin(v * 0.0045 + T * 0.4);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = ((r + rowShift) % rows) * cols + c;
      const x = c * CELL;
      let y = r * CELL - sub;
      let size = SIZE;
      const d = Math.hypot(x - pointer.x, y - pointer.y);
      const near = d < 160 ? (1 - d / 160) * 0.8 : 0;
      let a = Math.min(1, level[i] * edge[i] + near * (0.4 + base[i]));
      if (shock.on) {
        const dr = Math.hypot(x - cx, y - cy) - shock.r;
        if (dr > 0) continue;
        const ring = dr > -70 ? 1 + dr / 70 : 0;
        a = Math.min(1.2, a + ring * 1.1);
        size = SIZE * (1 + ring * 0.7);
      }
      let rgb = null, wa = 0;
      if (wave.on) {
        const kx = horizontal ? r : c;
        const dist = (horizontal ? x : H - y) - (front + wob[kx]);
        let k = dist >= 0 ? Math.max(0, 1 - dist / lead[kx]) : Math.pow(Math.max(0, 1 + dist / tail[kx]), 1.6);
        k *= ray[kx];
        if (k > 0.02) {
          wa = k;
          rgb = ramp(hue[kx], dist < 0 ? 1 - Math.max(0, 1 + dist / tail[kx]) : 0);
          size = SIZE * (1 + k * 0.8);
          y -= k * 16;
        }
      }
      if (a < 0.03 && wa < 0.03) continue;
      fx.fillStyle = rgb
        ? `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${Math.min(1, a * 0.3 + wa * 0.75)})`
        : `rgba(0,102,255,${Math.min(1, a) * 0.22})`;
      fx.fillRect(x, y, size, size);
    }
  }
  let fieldLast = 0;
  function fieldTick(t) {
    const live = field.shock.on || field.wave.on;
    if (!live && t - fieldLast < 1000 / FPS) return;
    fieldLast = t;
    for (let i = 0; i < level.length; i++) {
      if (Math.random() < 0.004) level[i] = 0.55 + Math.random() * 0.45;
      else level[i] += (base[i] - level[i]) * 0.08;
    }
    fieldDraw();
  }

  // ================= the rain floor (hero)
  const host = document.querySelector('[data-layer="intro"]');
  const rc = host?.querySelector('canvas.rain');
  const rx = rc?.getContext('2d');
  const word = host?.querySelector('[data-word-text]');
  const probe = host?.querySelector('[data-baseline]');
  const UMBRELLA = 70;
  const ease = (q) => (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  let RC = 12, RS = 7, W = 0, H = 0, rcols = 0, floor = 0, mid = 0, sigma = 1, rate = 1.6;
  let pool = new Uint8Array(0), cap = new Uint8Array(0), drops = [], sparks = [], motes = null, text = null;
  let raining = false, onScreen = true;

  function measure() {
    const o = host.getBoundingClientRect(), r = word.getBoundingClientRect();
    const base = probe.getBoundingClientRect().top - o.top;
    text = { x: r.left - o.left, w: r.width, h: r.height * 0.72, base };
    if (rain.lift <= 0 && Math.abs(base - floor) > 0.5) {
      floor = base;
      host.style.setProperty('--floor', `${floor}px`);
    }
  }
  function rainSize() {
    const r = host.getBoundingClientRect();
    W = r.width; H = r.height;
    rc.width = W * dpr; rc.height = H * dpr; rc.style.width = `${W}px`; rc.style.height = `${H}px`;
    rx.setTransform(dpr, 0, 0, dpr, 0, 0);
    [RC, RS] = W < 640 ? [7, 4] : [12, 7];
    measure();
    rcols = Math.ceil(W / RC);
    mid = text.x + text.w / 2;
    sigma = Math.max(60, text.w * 0.64);
    const peak = Math.ceil(text.h / RC) + 3;
    cap = Uint8Array.from({ length: rcols }, (_, c) => Math.round(peak * Math.exp(-0.5 * ((c * RC + RS / 2 - mid) / sigma) ** 4)));
    rate = Math.max(1, cap.reduce((a, b) => a + b, 0) / 640);
    pool = calm ? cap.slice() : Uint8Array.from({ length: rcols }, (_, c) => Math.min(pool[c] ?? 0, cap[c]));
    motes = null;
    rainDraw(0);
  }
  function splash(x, y, dir) {
    for (let k = 0; k < 2; k++) sparks.push({ x, y, vx: (dir || (Math.random() < 0.5 ? -1 : 1)) * (0.6 + Math.random() * 1.8), vy: -(1.2 + Math.random() * 2.6), life: 1 });
  }
  function rainStep(f) {
    if (raining && rain.lift <= 0) {
      for (let n = rate * f; n > 0; n--) {
        if (Math.random() >= n) continue;
        const x = Math.random() < 0.7 ? mid + gauss() * sigma * 0.85 : Math.random() * W;
        const c = Math.floor(x / RC);
        if (c >= 0 && c < rcols) drops.push({ c, y: -40 - Math.random() * 60, v: 1.4 + Math.random() * 1.8 });
      }
    }
    for (const d of drops) {
      const prev = d.y;
      d.v = Math.min(7, d.v + 0.07 * f);
      d.y += d.v * f;
      const x = d.c * RC + RS / 2, dx = x - pointer.x;
      const py = pointer.y - (host.getBoundingClientRect().top);
      if (Math.abs(dx) < UMBRELLA && py < floor) {
        const top = py - Math.sqrt(UMBRELLA * UMBRELLA - dx * dx) * 0.55;
        if (prev < top && d.y >= top) { splash(x, top, Math.sign(dx)); d.y = Infinity; continue; }
      }
      const surface = floor - pool[d.c] * RC;
      if (d.y >= surface) {
        if (pool[d.c] < cap[d.c] && rain.lift <= 0) pool[d.c]++;
        splash(x, surface, 0);
        d.y = Infinity;
      }
    }
    drops = drops.filter((d) => d.y !== Infinity);
    for (const s of sparks) { s.vy += 0.22 * f; s.x += s.vx * f; s.y += s.vy * f; s.life -= 0.045 * f; }
    sparks = sparks.filter((s) => s.life > 0);
  }
  function liftMotes() {
    const src = [];
    for (let c = 0; c < rcols; c++) for (let k = 0; k < pool[c]; k++) src.push({ x: c * RC, y: floor - (k + 1) * RC + (RC - RS) });
    while (src.length < 420 && rcols) {
      const c = Math.min(rcols - 1, Math.max(0, Math.floor((mid + gauss() * sigma * 0.7) / RC)));
      src.push({ x: c * RC, y: floor - RC + (RC - RS) });
    }
    const pts = [];
    for (const t of rain.targets) for (let y = t.y + RC; y < t.y + t.h - RC; y += RC) for (let x = t.x + RC; x < t.x + t.w - RC; x += RC) pts.push({ x, y });
    if (!pts.length) return [];
    src.sort((a, b) => a.x - b.x);
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    return src.map((s, i) => {
      const p = pts[Math.floor((i * pts.length) / src.length)];
      return { sx: s.x, sy: s.y, tx: p.x, ty: p.y, cx: (s.x + p.x) / 2 + (Math.random() - 0.5) * 260, cy: Math.min(s.y, p.y) - 60 - Math.random() * 180, d: (Math.abs(s.x - mid) / W) * 0.4 + Math.random() * 0.12 };
    });
  }
  function rainDraw(T) {
    if (!rx) return;
    rx.clearRect(0, 0, W, H);
    const L = rain.lift;
    if (L > 0) {
      motes ??= liftMotes();
      for (const m of motes) {
        const q = Math.min(1, Math.max(0, (L - m.d) / 0.55));
        if (q >= 1) continue;
        if (q <= 0) { rx.fillStyle = 'rgba(0,102,255,0.6)'; rx.fillRect(m.sx, m.sy, RS, RS); continue; }
        const e = ease(q), u = 1 - e;
        const x = u * u * m.sx + 2 * u * e * m.cx + e * e * m.tx;
        const y = u * u * m.sy + 2 * u * e * m.cy + e * e * m.ty;
        const w = q * 0.8; // cools to ice blue as it arrives
        const a = q < 0.75 ? 0.95 : (0.95 * (1 - q)) / 0.25;
        rx.fillStyle = `rgba(${(0 + 150 * w) | 0},${(102 + 90 * w) | 0},255,${a})`;
        rx.fillRect(x | 0, y | 0, RS, RS);
      }
      return;
    }
    motes = null;
    for (let c = 0; c < rcols; c++) {
      const x = c * RC;
      for (let k = 0; k < pool[c]; k++) {
        const top = k === pool[c] - 1;
        const y = floor - (k + 1) * RC;
        rx.fillStyle = `rgba(0,102,255,${top ? 0.55 + 0.25 * Math.sin(T * 3 + c * 0.7) : 0.18 + 0.03 * (pool[c] - k)})`;
        rx.fillRect(x, y + (RC - RS), RS, RS);
      }
    }
    for (const d of drops) {
      rx.fillStyle = 'rgba(0,102,255,0.9)';
      rx.fillRect(d.c * RC, d.y, RS, RS);
      rx.fillStyle = 'rgba(0,102,255,0.35)';
      rx.fillRect(d.c * RC, d.y - RC, RS, RS);
      rx.fillStyle = 'rgba(0,102,255,0.15)';
      rx.fillRect(d.c * RC, d.y - RC * 2, RS, RS);
    }
    for (const s of sparks) { rx.fillStyle = `rgba(0,102,255,${s.life * 0.8})`; rx.fillRect(s.x | 0, s.y | 0, 3, 3); }
  }

  // ================= one loop
  let raf = 0, prev = 0, running = false;
  function tick(t) {
    raf = requestAnimationFrame(tick);
    const f = prev ? Math.min(3, (t - prev) / 16.67) : 1;
    prev = t;
    fieldTick(t);
    if (rx && (onScreen || rain.lift > 0)) { rainStep(f); rainDraw(t / 1000); }
  }
  function start() { if (!running && !calm) { running = true; prev = 0; raf = requestAnimationFrame(tick); } }
  function stop() { running = false; cancelAnimationFrame(raf); }

  fieldResize();
  if (rx) {
    rainSize();
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(host);
    // the rain starts once the page is open (after the loader), measured again once the wordmark's font is in
    addEventListener('tz:loaded', () => { raining = true; }, { once: true });
    document.fonts?.ready.then(() => rainSize());
    window.TZ.rainResize = rainSize;
    window.TZ.measure = measure;
  }
  addEventListener('resize', () => { fieldResize(); if (rx) rainSize(); });
  if (!calm) {
    addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
    document.addEventListener('pointerleave', () => { pointer = { x: -1e4, y: -1e4 }; });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    start();
  } else {
    raining = false;
    fieldDraw();
  }
})();
