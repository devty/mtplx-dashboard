/** Prometheus text exposition parser. Pure: no I/O, no state, no clock.
 *
 *  Deliberately hand-rolled rather than pulling in a dependency — the format
 *  is small, and rapid-mlx emits two non-standard suffixes (_max, _last) that
 *  a strict library would either reject or reshape. Those arrive here as
 *  ordinary samples, which is exactly what callers want. */

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface PromFamily {
  name: string;
  type: string;
  help: string | null;
}

export interface PromScrape {
  families: Map<string, PromFamily>;
  samples: PromSample[];
}

/* Sample line: <name>[{labels}] <value> [<timestamp>]. The label blob is
   captured greedily and parsed separately, because a label value may itself
   contain a closing brace. */
const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+([^ \t]+)(?:[ \t]+[^ \t]+)?[ \t]*$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:\\.|[^"\\])*)"/g;

function unescape(v: string): string {
  return v.replace(/\\(.)/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c
  );
}

function parseValue(raw: string): number {
  if (raw === '+Inf' || raw === 'Inf') return Infinity;
  if (raw === '-Inf') return -Infinity;
  if (raw === 'NaN') return NaN;
  return Number(raw);
}

function parseLabels(blob: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!blob) return out;
  LABEL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL.exec(blob)) !== null) out[m[1]] = unescape(m[2]);
  return out;
}

function ensure(families: Map<string, PromFamily>, name: string): PromFamily {
  let f = families.get(name);
  if (!f) {
    f = { name, type: 'untyped', help: null };
    families.set(name, f);
  }
  return f;
}

export function parsePrometheus(text: string): PromScrape {
  const families = new Map<string, PromFamily>();
  const samples: PromSample[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const help = /^#[ \t]+HELP[ \t]+(\S+)[ \t]*(.*)$/.exec(line);
      if (help) {
        ensure(families, help[1]).help = help[2] || null;
        continue;
      }
      const type = /^#[ \t]+TYPE[ \t]+(\S+)[ \t]+(\S+)/.exec(line);
      if (type) ensure(families, type[1]).type = type[2];
      continue; // any other comment is ignored
    }

    const m = LINE.exec(line);
    if (!m) continue; // unparseable line is skipped, never thrown on
    samples.push({ name: m[1], labels: parseLabels(m[2]), value: parseValue(m[3]) });
  }

  return { families, samples };
}

/** First sample of `name` whose labels are a superset of `labels`. Returns null
 *  rather than throwing — a family may legitimately not exist yet (see the
 *  fixtures README on families that only appear after first traffic). */
export function findSample(
  scrape: PromScrape,
  name: string,
  labels?: Record<string, string>
): PromSample | null {
  for (const s of scrape.samples) {
    if (s.name !== name) continue;
    if (labels) {
      let ok = true;
      for (const k of Object.keys(labels)) {
        if (s.labels[k] !== labels[k]) { ok = false; break; }
      }
      if (!ok) continue;
    }
    return s;
  }
  return null;
}
