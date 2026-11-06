/**
 * Autopilot engine: runs a story of steps on the real pages. Pure: the DOM, navigation, storage, the sandbox API
 * and the chain are injected, so the engine is unit-tested with fakes. State is persisted after every action,
 * so a full page navigation resumes where it left off.
 */

export type Mode = 'presenter' | 'guest';
export type Status = 'idle' | 'running' | 'paused' | 'waiting-user' | 'failed' | 'done';
export type Ctx = Record<string, string>;
export type Chain = 'whitechain' | 'sepolia';
export type LogKind = 'info' | 'ok' | 'warn' | 'user' | 'sim' | 'error';
export type LogLine = { at: number; step: string; kind: LogKind; text: string; tx?: string; chain?: Chain; href?: string };

export interface Dom {
  path(): string;
  exists(testid: string): boolean;
  enabled(testid: string): boolean;
  text(testid: string): string | null;
  /** Attribute of the element, or of the first `inner` selector match inside it. */
  attr(testid: string, name: string, inner?: string): string | null;
  hasText(text: string): boolean;
  click(testid: string): void;
  fill(testid: string, value: string): void;
}

export type Wait = { testid?: string; enabled?: string; text?: string; textIn?: [testid: string, text: string]; test?: (d: Dom, c: Ctx) => boolean };
export type Val = string | ((c: Ctx) => string);

export type ApiResult = { ok: boolean; status?: string; tx?: string; txs?: string[]; chain?: Chain; detail?: string; error?: string; data?: Ctx };
export type ApiCall = { name: string; args?: (c: Ctx) => Record<string, string> };

export type Action = { mode?: Mode } & (
  | { do: 'goto'; path: Val }
  | { do: 'company'; id: Val }
  | { do: 'highlight'; testid: string; say?: string; ms?: number }
  | { do: 'fill'; testid: string; value: Val }
  | { do: 'click'; testid: string; optional?: boolean; timeout?: number }
  | { do: 'waitFor'; wait: Wait; timeout: number; say: string; optional?: boolean }
  | { do: 'userTap'; testid: string; prompt: string; until: Wait; timeout?: number }
  | { do: 'openTab'; url: string; prompt: string }
  | { do: 'capture'; testid: string; as: string; attr?: string; inner?: string; say?: (v: string, c: Ctx) => string; tx?: Chain }
  | { do: 'api'; call: ApiCall; say: string; sim?: boolean; expectRefusal?: boolean; saveAs?: string; retry?: { while: (r: ApiResult) => boolean; everyMs: number; maxMs: number; say: string } }
  | { do: 'assertChain'; key: string; chain: Chain }
  /** Reads topics[topic] of the first log with topic0 (from one of `addresses`) in the receipt of ctx[key]; stores it as ctx[as]. */
  | { do: 'receiptLog'; key: string; chain: Chain; topic0: string; topic: number; addresses: string[]; as: string; say: string; optional?: boolean }
  | { do: 'log'; text: Val; kind?: LogKind }
);

export type Step = { id: string; title: string; why: string; modes?: Mode[]; actions: Action[] };

export type RunState = {
  v: 1; mode: Mode; status: Status; step: number; action: number; ctx: Ctx; log: LogLine[]; done: string[];
  prompt?: string; highlight?: string; link?: string; acked?: boolean; error?: string; startedAt: number;
};

export type Deps = {
  dom: Dom;
  /** Full navigation returns true (this page is about to unload); same-page (hash) navigation returns false. */
  navigate(url: string): boolean;
  setCompany(id: string): void;
  api(name: string, args: Record<string, string>, c: Ctx): Promise<ApiResult>;
  receipt(chain: Chain, hash: string): Promise<'ok' | 'reverted' | null>;
  /** The receipt's logs, or null while it isn't mined yet. */
  receiptLogs?(chain: Chain, hash: string): Promise<{ address: string; topics: string[] }[] | null>;
  save(s: RunState | null): void;
  load(): RunState | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  onChange?(s: RunState | null): void;
  /** A human name for an element ("the Create payment link button"); defaults to the testid. */
  label?(testid: string): string;
};

export const KEY = 'tazor.autopilot.v1';
const POLL = 250;
const ELEMENT_TIMEOUT = 15_000;
const USER_TIMEOUT = 10 * 60_000;
const MAX_LOG = 200;
const TX = /^0x[0-9a-fA-F]{64}$/;

class Aborted extends Error {}

export const val = (v: Val, c: Ctx) => (typeof v === 'function' ? v(c) : v);

export function satisfied(w: Wait, d: Dom, c: Ctx): boolean {
  if (w.testid && !d.exists(w.testid)) return false;
  if (w.enabled && !d.enabled(w.enabled)) return false;
  if (w.text && !d.hasText(w.text)) return false;
  if (w.textIn && !(d.text(w.textIn[0]) ?? '').includes(w.textIn[1])) return false;
  if (w.test && !w.test(d, c)) return false;
  return true;
}

/** Normalised pathname for comparisons (trailing slash, no query or hash). */
export const pathOf = (url: string) => {
  const p = url.split(/[?#]/)[0] || '/';
  return p.endsWith('/') ? p : `${p}/`;
};

export function parseState(raw: string | null): RunState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as RunState;
    return s && s.v === 1 && typeof s.step === 'number' && typeof s.action === 'number' && Array.isArray(s.log) ? s : null;
  } catch {
    return null;
  }
}

export const appliesTo = (x: { mode?: Mode; modes?: Mode[] }, m: Mode) => (x.modes ? x.modes.includes(m) : x.mode ? x.mode === m : true);

/** Keys a step writes into ctx; keys written by more than one step (e.g. "the last link seen") are shared and kept. */
export function ownKeys(steps: Step[], index: number): string[] {
  const writes = (st: Step) => st.actions.flatMap((a) => (a.do === 'capture' ? [a.as, `${a.as}Tx`] : a.do === 'receiptLog' ? [a.as] : a.do === 'api' && a.saveAs ? [a.saveAs] : []));
  const mine = new Set(writes(steps[index]));
  for (const [i, st] of steps.entries()) if (i !== index) for (const k of writes(st)) mine.delete(k);
  return [...mine];
}

export function createRunner(steps: Step[], deps: Deps) {
  let st: RunState | null = deps.load();
  let gen = 0;
  let looping = false;

  const emit = () => { deps.save(st); deps.onChange?.(st); };
  const cur = () => st!;
  const stepId = () => steps[cur().step]?.id ?? 'end';
  function log(kind: LogKind, text: string, extra: Partial<LogLine> = {}) {
    const s = cur();
    s.log = [...s.log, { at: deps.now(), step: stepId(), kind, text, ...extra }].slice(-MAX_LOG);
    emit();
  }

  /** Polls until the wait is met; paused time does not count; controls abort it. */
  async function until(w: Wait, timeout: number, g: number): Promise<boolean> {
    let left = timeout;
    for (;;) {
      if (g !== gen) throw new Aborted();
      const s = cur();
      if (s.status !== 'paused' && satisfied(w, deps.dom, s.ctx)) return true;
      if (left <= 0) return false;
      await deps.sleep(POLL);
      if (cur().status !== 'paused') left -= POLL;
    }
  }

  const name = (t: string) => deps.label?.(t) ?? `"${t}"`;
  async function element(testid: string, g: number, timeout = ELEMENT_TIMEOUT) {
    if (!(await until({ testid, enabled: testid }, timeout, g))) throw new Error(`Timed out waiting for ${name(testid)} to be ready on this page.`);
  }

  /** Runs one action. 'next' advances; 'unload' means the page is navigating away (state already saved). */
  async function exec(a: Action, g: number): Promise<'next' | 'unload'> {
    const s = cur();
    switch (a.do) {
      case 'goto': {
        const url = val(a.path, s.ctx);
        if (pathOf(url) === pathOf(deps.dom.path()) && !url.includes('#')) return 'next';
        s.action++;
        emit();
        if (deps.navigate(url)) return 'unload';
        await deps.sleep(POLL);
        return 'next';
      }
      case 'company': deps.setCompany(val(a.id, s.ctx)); return 'next';
      case 'highlight': {
        await until({ testid: a.testid }, ELEMENT_TIMEOUT, g);
        s.highlight = a.testid; emit();
        if (a.say) log('info', a.say);
        await deps.sleep(a.ms ?? 1600);
        if (g !== gen) throw new Aborted();
        s.highlight = undefined; emit();
        return 'next';
      }
      case 'fill': {
        await element(a.testid, g);
        deps.dom.fill(a.testid, val(a.value, s.ctx));
        return 'next';
      }
      case 'click': {
        try { await element(a.testid, g, a.timeout); } catch (e) { if (a.optional && !(e instanceof Aborted)) return 'next'; throw e; }
        s.highlight = a.testid; emit();
        await deps.sleep(400);
        deps.dom.click(a.testid);
        s.highlight = undefined; emit();
        return 'next';
      }
      case 'waitFor': {
        log('info', a.say);
        if (await until(a.wait, a.timeout, g)) return 'next';
        if (a.optional) return 'next';
        throw new Error(`Timed out waiting for this: ${a.say.replace(/…$/, '')}.`);
      }
      case 'userTap': {
        await element(a.testid, g);
        s.status = 'waiting-user'; s.prompt = a.prompt; s.highlight = a.testid; emit();
        log('user', a.prompt);
        const ok = await until(a.until, a.timeout ?? USER_TIMEOUT, g);
        const now = cur();
        now.prompt = undefined; now.highlight = undefined;
        if (now.status === 'waiting-user') now.status = 'running';
        emit();
        if (!ok) throw new Error(`Timed out waiting for your tap. ${a.prompt.replace(/^Your turn: /, 'When you are ready: ')}`);
        return 'next';
      }
      case 'openTab': {
        s.status = 'waiting-user'; s.prompt = a.prompt; s.link = a.url; s.acked = false; emit();
        log('user', a.prompt);
        const ok = await until({ test: () => cur().acked === true }, USER_TIMEOUT, g);
        const now = cur();
        now.prompt = undefined; now.link = undefined; now.acked = undefined;
        if (now.status === 'waiting-user') now.status = 'running';
        emit();
        if (!ok) throw new Error('Timed out waiting for you to open the tab.');
        return 'next';
      }
      case 'capture': {
        await until({ testid: a.testid }, ELEMENT_TIMEOUT, g);
        const v = a.attr ? deps.dom.attr(a.testid, a.attr, a.inner) : deps.dom.text(a.testid);
        if (!v) throw new Error(`Couldn't read ${name(a.testid)} on this page.`);
        s.ctx = { ...s.ctx, [a.as]: v.trim() };
        const txHash = a.tx ? (v.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? '') : '';
        if (a.tx && txHash) s.ctx[`${a.as}Tx`] = txHash;
        const link = !txHash && a.attr === 'href' ? { href: v.trim() } : {};
        if (a.say) log(txHash ? 'ok' : 'info', a.say(v.trim(), s.ctx), txHash ? { tx: txHash, chain: a.tx } : link);
        else emit();
        return 'next';
      }
      case 'api': {
        log(a.sim ? 'sim' : 'info', a.say);
        let r = await deps.api(a.call.name, a.call.args ? a.call.args(s.ctx) : {}, s.ctx);
        if (g !== gen) throw new Aborted();
        // repeat an idempotent call while the service says "not yet" (e.g. Whitechain hasn't seen an ENS change)
        if (a.retry && r.ok && a.retry.while(r)) {
          log('info', a.retry.say);
          let waited = 0;
          while (r.ok && a.retry.while(r)) {
            if (waited >= a.retry.maxMs) throw new Error(`Timed out after ${Math.round(a.retry.maxMs / 1000)} s: ${a.retry.say.replace(/…$/, '')}.`);
            await until({ test: () => false }, a.retry.everyMs, g);
            waited += a.retry.everyMs;
            r = await deps.api(a.call.name, a.call.args ? a.call.args(cur().ctx) : {}, cur().ctx);
            if (g !== gen) throw new Aborted();
          }
        }
        if (r.data) s.ctx = { ...cur().ctx, ...r.data };
        const txs = [...(r.txs ?? []), ...(r.tx ? [r.tx] : [])].filter((t, i, xs) => TX.test(t) && xs.indexOf(t) === i);
        if (a.saveAs && txs.length) s.ctx = { ...cur().ctx, [a.saveAs]: txs[txs.length - 1] };
        if (a.expectRefusal) {
          if (r.ok) throw new Error('This should have been refused, but it went through.');
          log('ok', `Refused, as it should be: ${r.error ?? r.detail ?? 'rejected'}`);
          return 'next';
        }
        if (!r.ok) throw new Error(r.error ?? 'The service said no.');
        const done = r.detail ?? a.say.replace(/…$/, '').replace(/^Simulated counterparty: /, '') + ': done';
        txs.forEach((t, i) => log('ok', i === txs.length - 1 ? done : 'Step transaction', { tx: t, chain: r.chain ?? 'whitechain' }));
        if (!txs.length) log('ok', done);
        return 'next';
      }
      case 'assertChain': {
        const h = s.ctx[a.key];
        if (!h || !TX.test(h)) throw new Error('No transaction was recorded for this step.');
        for (let i = 0; i < 60; i++) {
          if (g !== gen) throw new Aborted();
          const r = await deps.receipt(a.chain, h);
          if (r === 'ok') { log('ok', `Confirmed on ${a.chain === 'sepolia' ? 'Ethereum Sepolia' : 'Whitechain'}`, { tx: h, chain: a.chain }); return 'next'; }
          if (r === 'reverted') { log('error', 'The transaction was refused on chain.', { tx: h, chain: a.chain }); throw new Error('The transaction was refused on chain (reverted).'); }
          await deps.sleep(1000);
        }
        throw new Error('Timed out waiting for the transaction to be confirmed.');
      }
      case 'receiptLog': {
        const h = s.ctx[a.key];
        if (!h || !TX.test(h) || !deps.receiptLogs) {
          if (a.optional) return 'next';
          throw new Error('No transaction was recorded for this step.');
        }
        const want = a.addresses.map((x) => x.toLowerCase());
        for (let i = 0; i < 60; i++) {
          if (g !== gen) throw new Aborted();
          const logs = await deps.receiptLogs(a.chain, h);
          if (logs) {
            const hit = logs.find((l) => want.includes(l.address.toLowerCase()) && l.topics[0]?.toLowerCase() === a.topic0.toLowerCase());
            const v = hit?.topics[a.topic];
            if (v) { cur().ctx = { ...cur().ctx, [a.as]: v }; log('info', a.say); return 'next'; }
            if (a.optional) return 'next';
            throw new Error('The transaction did not record what this step expected.');
          }
          await deps.sleep(1000);
        }
        if (a.optional) return 'next';
        throw new Error('Timed out waiting for the transaction to be confirmed.');
      }
      case 'log': log(a.kind ?? 'info', val(a.text, s.ctx)); return 'next';
    }
  }

  async function loop() {
    if (looping || !st) return;
    looping = true;
    try {
      for (;;) {
        const s = st;
        if (!s) return;
        if (s.status === 'paused') { await deps.sleep(POLL); continue; }
        if (s.status !== 'running' && s.status !== 'waiting-user') return;
        const step = steps[s.step];
        if (!step) { s.status = 'done'; s.highlight = undefined; s.prompt = undefined; log('ok', 'Autopilot finished: every step ran on the real pages.'); return; }
        if (!appliesTo(step, s.mode)) { s.step++; s.action = 0; emit(); continue; }
        if (s.action === 0) {
          // a fresh attempt never reuses values captured by an earlier attempt of this step
          const own = ownKeys(steps, s.step);
          if (own.some((k) => k in s.ctx)) { s.ctx = Object.fromEntries(Object.entries(s.ctx).filter(([k]) => !own.includes(k))); emit(); }
          if (!s.log.some((l) => l.step === step.id && l.text === step.title)) log('info', step.title);
        }
        const a = step.actions[s.action];
        if (!a) {
          if (!s.done.includes(step.id)) s.done = [...s.done, step.id];
          s.step++; s.action = 0; emit();
          continue;
        }
        if (!appliesTo(a, s.mode)) { s.action++; emit(); continue; }
        const g = gen;
        try {
          const before = s.action;
          const r = await exec(a, g);
          if (r === 'unload') return;
          if (g !== gen) continue;
          if (cur().action === before) cur().action++;
          emit();
        } catch (e) {
          if (e instanceof Aborted) continue;
          const now = cur();
          now.status = 'failed'; now.error = e instanceof Error ? e.message : String(e); now.highlight = undefined; now.prompt = undefined;
          log('error', now.error);
          return;
        }
      }
    } finally {
      looping = false;
    }
  }

  const control = (fn: (s: RunState) => void) => { if (!st) return; gen++; fn(st); emit(); void loop(); };

  return {
    state: () => st,
    start(mode: Mode) {
      gen++;
      st = { v: 1, mode, status: 'running', step: 0, action: 0, ctx: {}, log: [], done: [], startedAt: deps.now() };
      emit();
      void loop();
    },
    /** Picks up a run that was in progress before a navigation. */
    resume() { st = deps.load() ?? st; if (st && (st.status === 'running' || st.status === 'waiting-user')) void loop(); },
    pause() { if (st && (st.status === 'running' || st.status === 'waiting-user')) { st.status = 'paused'; emit(); } },
    play() { if (st?.status === 'paused') { st.status = st.prompt ? 'waiting-user' : 'running'; emit(); void loop(); } },
    skip() { control((s) => { s.step++; s.action = 0; s.status = 'running'; s.prompt = undefined; s.highlight = undefined; s.link = undefined; s.error = undefined; log('warn', 'Skipped'); }); },
    retry() { control((s) => { s.action = 0; s.status = 'running'; s.prompt = undefined; s.highlight = undefined; s.link = undefined; s.error = undefined; log('warn', 'Retrying this step'); }); },
    stop() { gen++; st = null; emit(); },
    ack() { if (st) { st.acked = true; emit(); } },
    /** For tests: resolves when the loop is idle. */
    async settle() { while (looping) await deps.sleep(POLL); },
  };
}

export type Runner = ReturnType<typeof createRunner>;
