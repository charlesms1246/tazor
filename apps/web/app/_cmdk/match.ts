/** Pure matching and ranking for the command palette (no DOM, no React). */

export const GROUPS = ['Pages', 'Actions', 'Invoices', 'Docs'] as const;
export type Group = (typeof GROUPS)[number];

export type Command = {
  id: string;
  group: Group;
  title: string;
  subtitle?: string;
  keywords?: string[];
  href?: string;
  action?: string;
};

export type Range = [start: number, end: number];
export type Hit = { cmd: Command; score: number; ranges: Range[] };
export type Section = { group: Group; hits: Hit[] };

const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const isWordStart = (s: string, i: number) => i === 0 || /[^a-z0-9]/i.test(s[i - 1]);

function mergeRanges(r: Range[]): Range[] {
  const sorted = [...r].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const x of sorted) {
    const last = out.at(-1);
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/**
 * Case-insensitive substring match: every query word must appear in the title or the keywords.
 * Lower score is better: 0 exact title, 1 title prefix, 2 every word at a word start in the title,
 * 3 every word inside the title, 4 some words only in keywords or subtitle. Null when it does not match.
 */
export function matchCommand(query: string, cmd: Command): Hit | null {
  const words = tokens(query);
  if (words.length === 0) return { cmd, score: 0, ranges: [] };
  const title = cmd.title.toLowerCase();
  const extra = [cmd.subtitle ?? '', ...(cmd.keywords ?? [])].join(' ').toLowerCase();
  const ranges: Range[] = [];
  let inTitle = 0;
  let atStart = 0;
  for (const w of words) {
    let i = title.indexOf(w);
    if (i >= 0) {
      let j = i;
      while (j >= 0 && !isWordStart(title, j)) j = title.indexOf(w, j + 1);
      if (j >= 0) { i = j; atStart++; }
      ranges.push([i, i + w.length]);
      inTitle++;
    } else if (!extra.includes(w)) {
      return null;
    }
  }
  const q = words.join(' ');
  const score = title === q ? 0
    : title.startsWith(q) ? 1
    : atStart === words.length ? 2
    : inTitle === words.length ? 3
    : 4;
  return { cmd, score, ranges: mergeRanges(ranges) };
}

/** Results grouped by section; sections ordered by their best hit, ties in GROUPS order. */
export function rank(query: string, cmds: Command[], opts: { emptyLimit?: Partial<Record<Group, number>>; limit?: number } = {}): Section[] {
  const empty = tokens(query).length === 0;
  const hits = cmds.map((c, i) => ({ hit: matchCommand(query, c), i })).filter((x): x is { hit: Hit; i: number } => x.hit !== null);
  const sections: Section[] = [];
  for (const group of GROUPS) {
    const g = hits.filter((x) => x.hit.cmd.group === group).sort((a, b) => a.hit.score - b.hit.score || a.i - b.i);
    const cap = empty ? opts.emptyLimit?.[group] ?? Infinity : opts.limit ?? 8;
    if (g.length) sections.push({ group, hits: g.slice(0, cap).map((x) => x.hit) });
  }
  if (!empty) sections.sort((a, b) => a.hits[0].score - b.hits[0].score || GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  return sections;
}

export const flatten = (s: Section[]): Hit[] => s.flatMap((x) => x.hits);

/** Moves a highlight by delta with wrap-around; -1 when the list is empty. */
export function moveIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return -1;
  return (((i + delta) % n) + n) % n;
}

/** Splits text into plain and highlighted runs for rendering. */
export function segments(text: string, ranges: Range[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
