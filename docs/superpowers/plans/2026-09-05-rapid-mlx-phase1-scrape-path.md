# rapid-mlx Phase 1: Scrape Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead MTPLX JSON poller with a Prometheus scraper against rapid-mlx, so the dashboard shows live engine metrics again from a single target, with no proxy and no dependency on gbrain being repointed.

**Architecture:** A pure text parser (`promParse.ts`) feeds a stateful differ (`promSeries.ts`) that converts cumulative counters into per-interval deltas and detects process restarts. `promScraper.ts` replaces `metricsPoller.ts` as the poll loop, writing discovered gauge series to SQLite and driving the sparkline rings from engine-reported values. `healthPoller.ts` keeps its role of owning run identity, but derives it from `uptime_seconds` going backwards instead of MTPLX's `startup.pid`.

**Tech Stack:** TypeScript 5.5 (CommonJS, `strict`), Node >= 22.5, Express 4, `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict`, `tsx` for dev/test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-rapid-mlx-prometheus-design.md` — read it before starting. This plan implements only the spec's **Phase 1** (spec section 10). Phases 2 (capture proxy) and 3 (multi-target) get their own plans.

## Global Constraints

- **No new runtime dependencies.** Express and `node:*` only. The parser is hand-rolled deliberately; do not add `prom-client` or a parsing library.
- **Node >= 22.5**, CommonJS output, `strict: true`. `node:sqlite` is the only database binding.
- **Persistence must never break the live dashboard.** Every `db.ts` method catches its own errors and degrades. New methods follow this without exception.
- **Test files are `server/*.test.ts`** and are excluded from `tsconfig` builds. Full run: `npm test`. Single file: `node --disable-warning=ExperimentalWarning --import tsx --test server/<name>.test.ts`.
- **Never assume a fixed metric family set.** Verified counts: 59 families on a cold qwen server, 73 after one request, 80 on gemma. Gauge series names are *discovered from the scrape*, never hardcoded.
- **`REQUEST_SERIES` stays a closed `Object.hasOwn` allowlist** because those names are interpolated into SQL. Gauge names are bound as parameters and may be dynamic. Do not "unify" these two.
- **Rendering/formatting stays duplicated** across `public/*.html` per the project's standing convention. Do not create a shared frontend module.
- Commit after every task. Conventional-commit prefixes (`feat:`, `refactor:`, `test:`, `chore:`).

---

## File Structure

**Created:**
- `server/promParse.ts` — pure Prometheus text exposition parser. No I/O, no state.
- `server/promParse.test.ts` — parser tests against the committed fixtures.
- `server/promSeries.ts` — series naming, counter deltas, reset detection. Pure logic over a small state object.
- `server/promSeries.test.ts`
- `server/promScraper.ts` — the poll loop. Replaces `metricsPoller.ts`.
- `server/targets.ts` — target list parsing (single target in Phase 1; the shape is what Phase 3 extends).

**Modified:**
- `server/db.ts` — schema v2, `target_id`, new `run` columns, `transcript` table, set-aside-on-mismatch.
- `server/db.test.ts` — schema assertions updated, new tests for set-aside and transcript prune.
- `server/healthPoller.ts` — run identity from `uptime_seconds` + `build_info`.
- `server/types.ts` — MTPLX types out, rapid-mlx types in; `StatePayload` reshaped.
- `server/config.ts` — target config, split scrape/forward timeouts.
- `server/server.ts` — wiring, `/api/history/gauges` name discovery.
- `public/index.html` — hero replacement and rewired cards.
- `public/log.html`, `public/detail.html` — explicit "awaiting Phase 2" state.
- `package.json`, `CLAUDE.md`, `README.md`, `.env.example` — retire MTPLX artifacts.

**Deleted:**
- `server/metricsPoller.ts` (+ any references)
- `patches/` (whole directory), `scripts/mtplx-postupgrade.sh`

---

## Task 1: Prometheus text parser

**Files:**
- Create: `server/promParse.ts`
- Test: `server/promParse.test.ts`
- Read-only reference: `server/fixtures/*.txt`, `server/fixtures/README.md`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface PromSample { name: string; labels: Record<string, string>; value: number }`
  - `interface PromFamily { name: string; type: string; help: string | null }`
  - `interface PromScrape { families: Map<string, PromFamily>; samples: PromSample[] }`
  - `function parsePrometheus(text: string): PromScrape`
  - `function findSample(scrape: PromScrape, name: string, labels?: Record<string, string>): PromSample | null`

**Background you need:** Prometheus text exposition is line-oriented. `# HELP <name> <text>` and `# TYPE <name> <type>` describe a family; every other non-blank, non-`#` line is a sample: `name{k="v",k2="v2"} 1.5` or `name 1.5`, with an optional trailing timestamp this server never emits. Label values are double-quoted with `\\`, `\"` and `\n` escapes. Values may be `+Inf`, `-Inf` or `NaN`. Histogram families expand into `_bucket{le="..."}`, `_sum` and `_count` samples; rapid-mlx additionally emits non-standard `_max` and `_last` gauges, which need no special handling — they arrive as ordinary samples.

- [ ] **Step 1: Write the failing test**

Create `server/promParse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus, findSample } from './promParse';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const COLD = 'rapid-mlx-0.13.4-cold.txt';
const AFTER = 'rapid-mlx-0.13.4-after-first-request.txt';
const GEMMA = 'rapid-mlx-0.13.4-gemma.txt';

test('parses an unlabelled sample', () => {
  const s = parsePrometheus('# TYPE x gauge\nx 1.5\n');
  assert.equal(s.samples.length, 1);
  assert.deepEqual(s.samples[0], { name: 'x', labels: {}, value: 1.5 });
});

test('parses labels, including values containing separators', () => {
  const s = parsePrometheus('m{a="1",b="p/q--r,s"} 7\n');
  assert.deepEqual(s.samples[0].labels, { a: '1', b: 'p/q--r,s' });
  assert.equal(s.samples[0].value, 7);
});

test('unescapes backslash, quote and newline in label values', () => {
  const s = parsePrometheus('m{a="x\\\\y\\"z\\n"} 1\n');
  assert.equal(s.samples[0].labels.a, 'x\\y"z\n');
});

test('parses +Inf, -Inf and NaN values', () => {
  const s = parsePrometheus('a +Inf\nb -Inf\nc NaN\n');
  assert.equal(s.samples[0].value, Infinity);
  assert.equal(s.samples[1].value, -Infinity);
  assert.ok(Number.isNaN(s.samples[2].value));
});

test('ignores a trailing timestamp column', () => {
  const s = parsePrometheus('m 1.5 1788600000000\n');
  assert.equal(s.samples[0].value, 1.5);
});

test('records family type and help', () => {
  const s = parsePrometheus('# HELP m Some help text.\n# TYPE m counter\nm 1\n');
  assert.equal(s.families.get('m')?.type, 'counter');
  assert.equal(s.families.get('m')?.help, 'Some help text.');
});

test('tolerates blank lines and comments that are neither HELP nor TYPE', () => {
  const s = parsePrometheus('\n# something else\n\nm 1\n');
  assert.equal(s.samples.length, 1);
});

/* The family set is not fixed. These three counts are the contract: a parser
   that hardcodes a family list passes the first two and fails the third. */
test('fixture family counts differ by traffic state and by backend', () => {
  assert.equal(parsePrometheus(fixture(COLD)).families.size, 59);
  assert.equal(parsePrometheus(fixture(AFTER)).families.size, 73);
  assert.equal(parsePrometheus(fixture(GEMMA)).families.size, 80);
});

test('gemma exposes a prefix_cache_radix subsystem qwen does not', () => {
  const qwen = parsePrometheus(fixture(AFTER)).families;
  const gemma = parsePrometheus(fixture(GEMMA)).families;
  assert.equal(qwen.has('rapid_mlx_prefix_cache_radix_nodes'), false);
  assert.equal(gemma.has('rapid_mlx_prefix_cache_radix_nodes'), true);
});

/* _max and _last only exist once a request has completed. */
test('cold fixture lacks the _last gauge the warm one has', () => {
  const cold = parsePrometheus(fixture(COLD));
  const after = parsePrometheus(fixture(AFTER));
  assert.equal(findSample(cold, 'rapid_mlx_model_decode_tokens_per_second_last'), null);
  assert.equal(
    findSample(after, 'rapid_mlx_model_decode_tokens_per_second_last')?.value,
    36.726379
  );
});

/* The model label is a full filesystem path with -- separators and a 40-char
   hash. It must round-trip byte-for-byte. */
test('round-trips a filesystem-path label value', () => {
  const s = parsePrometheus(fixture(AFTER));
  const sample = findSample(s, 'rapid_mlx_model_completion_tokens_total');
  assert.ok(sample);
  assert.ok(sample.labels.model.startsWith('/Users/'));
  assert.ok(sample.labels.model.includes('models--unsloth--Qwen3.6-35B-A3B-UD-MLX-4bit'));
  assert.equal(sample.value, 9);
});

test('findSample matches on a label subset', () => {
  const s = parsePrometheus(fixture(AFTER));
  assert.equal(findSample(s, 'rapid_mlx_kv_cache_dtype', { dtype: 'bf16' })?.value, 1);
  assert.equal(findSample(s, 'rapid_mlx_kv_cache_dtype', { dtype: 'int4' })?.value, 0);
  assert.equal(findSample(s, 'rapid_mlx_kv_cache_dtype', { dtype: 'nope' }), null);
});

test('parses cumulative histogram buckets including +Inf', () => {
  const s = parsePrometheus(fixture(AFTER));
  const at = (le: string) =>
    findSample(s, 'rapid_mlx_model_ttft_seconds_bucket', { le })?.value ?? null;
  /* Buckets are cumulative. The one completed request took 0.393659s, so every
     bucket below it is 0 and every bucket from le=0.5 up carries the 1, with
     +Inf always holding the full count. */
  assert.equal(at('0.25'), 0);
  assert.equal(at('0.5'), 1);
  assert.equal(at('+Inf'), 1);
  assert.equal(findSample(s, 'rapid_mlx_model_ttft_seconds_count')?.value, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promParse.test.ts`
Expected: FAIL — `Cannot find module './promParse'`.

- [ ] **Step 3: Write the implementation**

Create `server/promParse.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promParse.test.ts`
Expected: PASS, 13 tests.

If the three family-count assertions fail, do **not** adjust the expected numbers — re-read `server/fixtures/README.md`. Those counts are the contract that proves the family set is dynamic.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/promParse.ts server/promParse.test.ts
git commit -m "feat: add Prometheus text exposition parser"
```

---

## Task 2: Series naming and counter deltas

**Files:**
- Create: `server/promSeries.ts`
- Test: `server/promSeries.test.ts`

**Interfaces:**
- Consumes: `PromSample`, `PromScrape`, `parsePrometheus`, `findSample` from `./promParse`.
- Produces:
  - `function seriesName(sample: PromSample): string`
  - `class CounterState` with `delta(series: string, value: number): number | null` and `reset(): void`
  - `function detectRestart(prevUptimeS: number | null, uptimeS: number | null): boolean`

**Background you need:** Prometheus counters are cumulative since process start, so every rate this dashboard shows is a delta between two scrapes. A counter that *decreases* means the process restarted, and the delta is meaningless — return `null`, never a negative or a bogus spike. The very first observation of a series also has no previous value, so it too yields `null`.

Two labels are dropped from stored series names. `model` is a full filesystem path (enormous, and constant for a target) and `family` is the model family (likewise constant). The `target_id` column already carries that information. Every other label is a real dimension — `reason`, `dtype`, `mode`, `status`, `outcome`, `k`, `le`, `path_kind`, `method` — and is kept.

- [ ] **Step 1: Write the failing test**

Create `server/promSeries.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus, findSample } from './promParse';
import { seriesName, CounterState, detectRestart } from './promSeries';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('strips the rapid_mlx_ prefix', () => {
  assert.equal(
    seriesName({ name: 'rapid_mlx_requests_running', labels: {}, value: 0 }),
    'requests_running'
  );
});

test('leaves a non-prefixed name alone', () => {
  assert.equal(seriesName({ name: 'other_metric', labels: {}, value: 0 }), 'other_metric');
});

test('appends remaining labels in sorted key order', () => {
  const n = seriesName({
    name: 'rapid_mlx_suffix_decode_fallthrough_total',
    labels: { reason: 'cooldown', method: 'suffix' },
    value: 0,
  });
  assert.equal(n, 'suffix_decode_fallthrough_total{method=suffix,reason=cooldown}');
});

test('label order in the input does not change the series name', () => {
  const a = seriesName({ name: 'm', labels: { b: '2', a: '1' }, value: 0 });
  const b = seriesName({ name: 'm', labels: { a: '1', b: '2' }, value: 0 });
  assert.equal(a, b);
});

/* model is a filesystem path and family is constant per target; target_id
   carries both. Keeping them would make series names enormous and unstable
   across a weights swap. */
test('drops the model and family labels', () => {
  const n = seriesName({
    name: 'rapid_mlx_model_completion_tokens_total',
    labels: { model: '/Users/x/models--unsloth--Qwen3.6', family: 'qwen3.6' },
    value: 0,
  });
  assert.equal(n, 'model_completion_tokens_total');
});

test('dropping model still leaves genuine dimensions', () => {
  const n = seriesName({
    name: 'rapid_mlx_model_requests_total',
    labels: { model: '/Users/x/y', outcome: 'failed' },
    value: 0,
  });
  assert.equal(n, 'model_requests_total{outcome=failed}');
});

/* Label values are free-form. Without encoding, {a:'x', b:'y'} and
   {a:'x,b=y'} both render as m{a=x,b=y} — two unrelated series sharing one
   persisted key, unrecoverably merged. */
test('label values that contain separators cannot collide', () => {
  const flat = seriesName({ name: 'm', labels: { a: 'x', b: 'y' }, value: 0 });
  const nested = seriesName({ name: 'm', labels: { a: 'x,b=y' }, value: 0 });
  assert.notEqual(flat, nested);
  assert.equal(flat, 'm{a=x,b=y}');
  assert.equal(nested, 'm{a=x%2Cb%3Dy}');
});

test('braces and percent signs in a label value are encoded', () => {
  assert.equal(
    seriesName({ name: 'm', labels: { a: '{100%}' }, value: 0 }),
    'm{a=%7B100%25%7D}'
  );
});

test('a real fixture sample produces a compact series name', () => {
  const s = parsePrometheus(fixture('rapid-mlx-0.13.4-after-first-request.txt'));
  const sample = findSample(s, 'rapid_mlx_model_requests_total', { outcome: 'succeeded' });
  assert.ok(sample);
  assert.equal(seriesName(sample), 'model_requests_total{outcome=succeeded}');
});

test('first observation of a series yields null, not the raw value', () => {
  const c = new CounterState();
  assert.equal(c.delta('a', 10), null);
  assert.equal(c.delta('a', 14), 4);
});

test('successive deltas are per-interval, not cumulative', () => {
  const c = new CounterState();
  c.delta('a', 0);
  assert.equal(c.delta('a', 5), 5);
  assert.equal(c.delta('a', 8), 3);
  assert.equal(c.delta('a', 8), 0);
});

/* A decrease means the process restarted. Returning a negative delta would
   render as a downward spike; returning the raw value would render as a
   lifetime total masquerading as one interval. Both are wrong. */
test('a decrease yields null and rebaselines', () => {
  const c = new CounterState();
  c.delta('a', 100);
  assert.equal(c.delta('a', 3), null);
  assert.equal(c.delta('a', 7), 4);
});

test('series are tracked independently', () => {
  const c = new CounterState();
  c.delta('a', 1);
  c.delta('b', 100);
  assert.equal(c.delta('a', 2), 1);
  assert.equal(c.delta('b', 250), 150);
});

test('reset() clears all baselines', () => {
  const c = new CounterState();
  c.delta('a', 1);
  c.reset();
  assert.equal(c.delta('a', 2), null);
});

test('detectRestart is true only when uptime goes backwards', () => {
  assert.equal(detectRestart(100, 101), false);
  assert.equal(detectRestart(100, 100), false);
  assert.equal(detectRestart(100, 3), true);
  assert.equal(detectRestart(null, 5), false); // first observation is not a restart
  assert.equal(detectRestart(100, null), false); // a failed scrape is not a restart
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promSeries.test.ts`
Expected: FAIL — `Cannot find module './promSeries'`.

- [ ] **Step 3: Write the implementation**

Create `server/promSeries.ts`:

```ts
import type { PromSample } from './promParse';

/** Labels dropped from stored series names. `model` is a full filesystem
 *  snapshot path (enormous, and it changes on a weights swap without the
 *  series meaning anything different); `family` is constant per target. The
 *  target_id column already carries both. Every other label is a real
 *  dimension and is kept. */
const DROPPED_LABELS = new Set(['model', 'family']);

const PREFIX = 'rapid_mlx_';

/** Percent-encodes the four characters that carry structure in a series name,
 *  plus `%` itself so the encoding is reversible.
 *
 *  Prometheus label values are free-form strings: nothing stops a future
 *  rapid-mlx version emitting `reason="a,b"`. Unencoded, `{a=x,b=y}` and
 *  `{a="x,b=y"}` collapse to the identical key, and because these strings are
 *  persisted, two unrelated series would merge into one history that can never
 *  be separated again. Encoding is free here and impossible to retrofit once
 *  rows exist. */
function encodeLabelValue(v: string): string {
  return v.replace(/[%,={}]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Stable DB key for a sample. Label keys are sorted so the same sample always
 *  produces the same string regardless of scrape ordering — these strings are
 *  persisted, so instability would fragment history into parallel series. */
export function seriesName(sample: PromSample): string {
  const base = sample.name.startsWith(PREFIX)
    ? sample.name.slice(PREFIX.length)
    : sample.name;

  const keys = Object.keys(sample.labels)
    .filter(k => !DROPPED_LABELS.has(k))
    .sort();
  if (!keys.length) return base;

  const parts = keys.map(k => `${k}=${encodeLabelValue(sample.labels[k])}`);
  return `${base}{${parts.join(',')}}`;
}

/** Per-interval deltas over cumulative counters.
 *
 *  Returns null in the two cases where no honest delta exists: the first
 *  observation of a series (no baseline), and a decrease (the process
 *  restarted, so the counter rebased). Callers persist null rather than
 *  substituting a value — the renderers already show an em-dash for null. */
export class CounterState {
  private prev = new Map<string, number>();

  delta(series: string, value: number): number | null {
    const last = this.prev.get(series);
    this.prev.set(series, value);
    if (last === undefined) return null;
    if (value < last) return null; // counter reset
    return value - last;
  }

  reset(): void {
    this.prev.clear();
  }
}

/** A decrease in uptime_seconds is the restart signal — rapid-mlx exposes no
 *  pid or start timestamp, so this is the only exact one available. */
export function detectRestart(
  prevUptimeS: number | null,
  uptimeS: number | null
): boolean {
  if (prevUptimeS === null || uptimeS === null) return false;
  return uptimeS < prevUptimeS;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promSeries.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/promSeries.ts server/promSeries.test.ts
git commit -m "feat: add series naming and counter delta tracking"
```

---

## Task 3: Schema v2

**Files:**
- Modify: `server/db.ts` — `SCHEMA_VERSION`, `DDL`, `StoreOptions`, `RunInfo`, `RunRow`, `RunSummary`, `REQUEST_SERIES`, `SqliteStore` constructor, `upsertRun`, `insertGauge`, `prune`
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces:
  - `SCHEMA_VERSION = 2`
  - `interface StoreOptions { path: string; enabled: boolean; retentionDays: number; transcriptRetentionDays: number }`
  - `interface RunInfo { targetId: string; startedAt: number; model: string | null; version: string | null; kvCacheDtype: string | null; turboquantMode: string | null; specDecodeMethod: string | null; engineType: string | null; contextWindow: number | null; health: string }`
  - `Store.insertGauge(targetId: string, series: string, value: number | null, ts: number): void`
  - `Store.upsertRun(info: RunInfo, now: number): number | null`

**Background you need:** The current constructor writes `PRAGMA user_version` but never *reads* it, so there is no upgrade path at all. Per spec §5 there is deliberately no migration: on a version mismatch the old file is renamed aside and a fresh one created. MTPLX and rapid-mlx numbers are not comparable, so migrating would produce history that silently lies across the boundary.

SQLite in WAL mode keeps two sidecar files, `-wal` and `-shm`. Renaming only the `.db` leaves those behind and the new database can be corrupted by them. Move all three.

The full v2 `request` shape is created now even though nothing writes to it in Phase 1. Deferring those columns to Phase 2 would mean a second version bump, which under the set-aside rule would discard the history Phase 1 spent weeks collecting. This is not speculative generality — it is avoiding a destructive second migration.

- [ ] **Step 1: Write the failing test**

Add to `server/db.test.ts`. First extend its import to `import { createStore, SCHEMA_VERSION, REQUEST_SERIES } from './db';` (controller ruling R3 — the new cases reference `REQUEST_SERIES`). Then update the existing `tmpStore` helper to pass the new option, then add these tests:

```ts
/* Replace the existing tmpStore signature with this one. */
function tmpStore(retentionDays = 30, transcriptRetentionDays = 7) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');
  const store = createStore({
    path: file,
    enabled: true,
    retentionDays,
    transcriptRetentionDays,
  });
  const read = <T = Record<string, unknown>>(sql: string): T[] => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare(sql).all() as unknown as T[];
    } finally {
      db.close();
    }
  };
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, read, file, dir, cleanup };
}

test('v2 schema has the transcript table', () => {
  const { read, cleanup } = tmpStore();
  const tables = read<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).map(r => r.name);
  assert.deepEqual(tables, ['gauge', 'request', 'run', 'transcript']);
  const [{ user_version }] = read<{ user_version: number }>('PRAGMA user_version');
  assert.equal(user_version, 2);
  cleanup();
});

test('every time-series table carries target_id', () => {
  const { read, cleanup } = tmpStore();
  for (const t of ['run', 'request', 'gauge']) {
    const cols = read<{ name: string }>(`PRAGMA table_info(${t})`).map(c => c.name);
    assert.ok(cols.includes('target_id'), `${t} is missing target_id`);
  }
  cleanup();
});

test('run drops the MTPLX-only columns and gains the rapid-mlx ones', () => {
  const { read, cleanup } = tmpStore();
  const cols = read<{ name: string }>('PRAGMA table_info(run)').map(c => c.name);
  for (const gone of ['pid', 'runtime_mode', 'generation_mode', 'depth', 'verify_core', 'paged_kv_quantization']) {
    assert.equal(cols.includes(gone), false, `run should not have ${gone}`);
  }
  for (const added of ['version', 'kv_cache_dtype', 'turboquant_mode', 'spec_decode_method', 'engine_type']) {
    assert.ok(cols.includes(added), `run is missing ${added}`);
  }
  cleanup();
});

test('request sheds the MTP block and gains the proxy columns', () => {
  const { read, cleanup } = tmpStore();
  const cols = read<{ name: string }>('PRAGMA table_info(request)').map(c => c.name);
  for (const gone of ['drafted_by_depth', 'accepted_by_depth', 'accept_rate', 'mtp_depth',
                      'bonus_tokens', 'correction_tokens', 'verify_calls', 'draft_time_s',
                      'verify_forward_time_s', 'verify_eval_time_s', 'accept_time_s',
                      'cache_source', 'session_cache_hit', 'cached_tokens',
                      'cache_restore_time_s', 'ssd_cache_hit', 'ssd_cached_tokens']) {
    assert.equal(cols.includes(gone), false, `request should not have ${gone}`);
  }
  for (const added of ['outcome', 'status_code', 'streamed', 'finish_reason', 'engine_joined']) {
    assert.ok(cols.includes(added), `request is missing ${added}`);
  }
  cleanup();
});

test('REQUEST_SERIES keeps only the two request-derived sparklines', () => {
  assert.deepEqual(Object.keys(REQUEST_SERIES).sort(), ['decode', 'ttft']);
});

/* Spec section 5: no migration. The old file is moved aside, WAL sidecars and
   all, and a fresh v2 database takes its place. */
test('a v1 database is set aside rather than migrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const old = new DatabaseSync(file);
  old.exec('PRAGMA user_version = 1');
  old.exec('CREATE TABLE legacy (x INTEGER)');
  old.exec('INSERT INTO legacy VALUES (42)');
  old.close();

  const store = createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 });
  assert.equal(store.status().ok, true);

  const aside = path.join(dir, 'history-v1-mtplx.db');
  assert.ok(fs.existsSync(aside), 'old database was not set aside');

  const kept = new DatabaseSync(aside);
  assert.deepEqual(kept.prepare('SELECT x FROM legacy').all(), [{ x: 42 }]);
  kept.close();

  const fresh = new DatabaseSync(file);
  const [{ user_version }] = fresh.prepare('PRAGMA user_version').all() as { user_version: number }[];
  assert.equal(user_version, 2);
  assert.equal(
    fresh.prepare(`SELECT name FROM sqlite_master WHERE name = 'legacy'`).all().length,
    0,
    'fresh database should not contain the old schema'
  );
  fresh.close();

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* fs.renameSync clobbers silently. The realistic trigger is a user copying
   their archive back to the live path to inspect it. */
test('a second set-aside never destroys the first archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const makeV1 = (x: number) => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 1');
    db.exec('CREATE TABLE legacy (x INTEGER)');
    db.exec(`INSERT INTO legacy VALUES (${x})`);
    db.close();
  };
  const rows = (f: string) => {
    const db = new DatabaseSync(f);
    try {
      return (db.prepare('SELECT x FROM legacy').all() as { x: number }[]).map(r => r.x);
    } finally {
      db.close();
    }
  };
  const opts = { enabled: true, retentionDays: 30, transcriptRetentionDays: 7 };

  makeV1(42);
  createStore({ path: file, ...opts }).close();
  fs.rmSync(file);

  makeV1(7);
  createStore({ path: file, ...opts }).close();

  assert.deepEqual(rows(path.join(dir, 'history-v1-mtplx.db')), [42], 'first archive was destroyed');
  assert.deepEqual(rows(path.join(dir, 'history-v1-mtplx.2.db')), [7]);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* The -wal/-shm move is the whole reason this block exists; without it a stale
   WAL can be replayed into the fresh database. Sidecars are written as plain
   files here because setAsideIfStale only tests existence and renames. */
test('WAL sidecars move with the set-aside database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 1');
  db.exec('CREATE TABLE legacy (x INTEGER)');
  db.close();
  fs.writeFileSync(file + '-wal', 'stale-wal');
  fs.writeFileSync(file + '-shm', 'stale-shm');

  createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 }).close();

  const aside = path.join(dir, 'history-v1-mtplx.db');
  assert.equal(fs.readFileSync(aside + '-wal', 'utf8'), 'stale-wal');
  assert.equal(fs.readFileSync(aside + '-shm', 'utf8'), 'stale-shm');
  assert.equal(fs.existsSync(file + '-wal'), false, 'stale -wal left beside the fresh database');
  assert.equal(fs.existsSync(file + '-shm'), false, 'stale -shm left beside the fresh database');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an orphaned sidecar does not get overwritten by a set-aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 1');
  db.exec('CREATE TABLE legacy (x INTEGER)');
  db.close();
  fs.writeFileSync(file + '-wal', 'incoming-wal');

  /* An archive whose .db was deleted but whose sidecar was left behind. */
  fs.writeFileSync(path.join(dir, 'history-v1-mtplx.db-wal'), 'orphan');

  createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 }).close();

  assert.equal(
    fs.readFileSync(path.join(dir, 'history-v1-mtplx.db-wal'), 'utf8'),
    'orphan',
    'orphaned sidecar was overwritten'
  );
  assert.equal(fs.readFileSync(path.join(dir, 'history-v1-mtplx.2.db-wal'), 'utf8'), 'incoming-wal');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a matching version is left alone', () => {
  const { store, file, dir, cleanup } = tmpStore();
  store.close();
  const reopened = createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 });
  assert.equal(reopened.status().ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'history-v2-mtplx.db')), false);
  reopened.close();
  cleanup();
});

test('gauges are scoped by target', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertGauge('qwen', 'requests_running', 1, 1000);
  store.insertGauge('gemma', 'requests_running', 5, 1000);
  const rows = read<{ target_id: string; value: number }>(
    `SELECT target_id, value FROM gauge ORDER BY target_id`
  );
  assert.deepEqual(rows, [
    { target_id: 'gemma', value: 5 },
    { target_id: 'qwen', value: 1 },
  ]);
  cleanup();
});

/* Transcripts age out on their own clock so bodies do not force the metrics
   history to be short, and metrics retention does not force bodies to be kept. */
test('transcripts prune on their own retention, ahead of requests', () => {
  const { store, read, cleanup } = tmpStore(30, 7);
  const now = Date.UTC(2026, 8, 5);
  const tenDaysAgo = now - 10 * 86_400_000;

  store.insertRequestRow({ requestId: 'r1', targetId: 'qwen', runId: null, ts: tenDaysAgo });
  store.insertTranscript('r1', '[{"role":"user","content":"hi"}]', 'hello', null, false);

  assert.equal(read(`SELECT 1 FROM transcript`).length, 1);
  store.prune(now);
  assert.equal(read(`SELECT 1 FROM transcript`).length, 0, 'transcript should be pruned at 7d');
  assert.equal(read(`SELECT 1 FROM request`).length, 1, 'request should survive to 30d');
  cleanup();
});
```

Delete any existing test in `db.test.ts` that asserts on the removed MTPLX columns or the old four-key `REQUEST_SERIES`; those assertions are now wrong by design.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/db.test.ts`
Expected: FAIL — missing `transcript` table, missing `target_id`, `insertRequestRow`/`insertTranscript` not functions.

- [ ] **Step 3: Write the implementation**

In `server/db.ts`:

**3a.** Set `export const SCHEMA_VERSION = 2;`

**3b.** Replace `DDL` with:

```ts
const DDL = `
  CREATE TABLE IF NOT EXISTS run (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id           TEXT    NOT NULL,
    started_at          INTEGER NOT NULL,
    detected_at         INTEGER NOT NULL,
    ended_at            INTEGER,
    model               TEXT,
    version             TEXT,
    kv_cache_dtype      TEXT,
    turboquant_mode     TEXT,
    spec_decode_method  TEXT,
    engine_type         TEXT,
    context_window      INTEGER,
    health              TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS run_identity ON run(target_id, started_at);

  CREATE TABLE IF NOT EXISTS request (
    request_id        TEXT PRIMARY KEY,
    target_id         TEXT    NOT NULL,
    run_id            INTEGER REFERENCES run(id) ON DELETE SET NULL,
    ts                INTEGER NOT NULL,
    model             TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    ttft_s            REAL,
    request_elapsed_s REAL,
    decode_tok_s      REAL,
    client_label      TEXT,
    tool_call_count   INTEGER,
    user_preview      TEXT,
    outcome           TEXT,
    status_code       INTEGER,
    streamed          INTEGER,
    finish_reason     TEXT,
    engine_joined     INTEGER
  );
  CREATE INDEX IF NOT EXISTS request_ts        ON request(ts);
  CREATE INDEX IF NOT EXISTS request_target_ts ON request(target_id, ts);
  CREATE INDEX IF NOT EXISTS request_run_ts    ON request(run_id, ts);

  CREATE TABLE IF NOT EXISTS transcript (
    request_id    TEXT PRIMARY KEY REFERENCES request(request_id) ON DELETE CASCADE,
    ts            INTEGER NOT NULL,
    messages      TEXT,
    response_text TEXT,
    tools         TEXT,
    truncated     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS transcript_ts ON transcript(ts);

  CREATE TABLE IF NOT EXISTS gauge (
    ts        INTEGER NOT NULL,
    target_id TEXT    NOT NULL,
    series    TEXT    NOT NULL,
    value     REAL
  );
  CREATE INDEX IF NOT EXISTS gauge_target_series_ts ON gauge(target_id, series, ts);
  CREATE INDEX IF NOT EXISTS gauge_ts ON gauge(ts);
`;
```

**3c.** Replace `REQUEST_SERIES`. Only decode and ttft remain request-derived; prefill and accept move to gauges (spec §5.4):

```ts
/** Closed allowlist: series name → SQL expression over `request`. Names arrive
 *  from query strings, so nothing outside this map is ever interpolated.
 *
 *  Only two sparklines are request-derived under rapid-mlx. `prefill` and
 *  `accept` have no per-request source — /v1/status.prompt_tps is
 *  instantaneous and spec_decode_accept_ratio is server-wide — so they are
 *  read from `gauge` instead, via queryGauges(). Do not add them here; gauge
 *  names are bound as parameters, these are interpolated. */
export const REQUEST_SERIES: Record<string, string> = {
  decode: 'decode_tok_s',
  ttft: 'ttft_s',
};
```

Delete the now-unused `acceptRate()` export and its `sumArr` helper, plus the `drafted`/`accepted`/`accept_rate` handling in the old insert path.

**3d.** Add the set-aside step to the `SqliteStore` constructor, before opening:

```ts
  constructor(private readonly options: StoreOptions) {
    if (!options.enabled) return;
    try {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      this.setAsideIfStale(options.path);
      const db = new DatabaseSync(options.path);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA busy_timeout = 2000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(DDL);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db = db;
    } catch (err) {
      this.fail('open', err);
    }
  }

  /** Spec section 5: no migration. A database written by an older schema is
   *  renamed aside and a fresh one created, because MTPLX-era rows and
   *  rapid-mlx rows are not comparable and a migration would produce history
   *  that lies across the boundary.
   *
   *  The -wal and -shm sidecars move with the file. Leaving them behind would
   *  let a stale WAL be replayed into the new database. */
  private setAsideIfStale(file: string): void {
    if (!fs.existsSync(file)) return;

    let version = 0;
    const probe = new DatabaseSync(file);
    try {
      const rows = probe.prepare('PRAGMA user_version').all() as { user_version: number }[];
      version = rows[0]?.user_version ?? 0;
    } finally {
      probe.close();
    }
    if (version === 0 || version === SCHEMA_VERSION) return;

    const base = file.replace(/\.db$/, '');
    /* fs.renameSync overwrites its destination silently, and the aside name is
       a pure function of (base, version) — so a second set-aside at the same
       version would destroy the first archive. That is not hypothetical: the
       likeliest path to it is a user copying their archive back to the live
       path to look at it, and the next start eating it. Never reuse a name.
       Uniqueness also guarantees the new aside has no pre-existing -wal/-shm
       to inherit, which is the corruption this whole block exists to avoid. */
    /* A name is taken if ANY of its three files exists. Probing only the .db
       would let an orphaned sidecar — left by a crash, or by deleting an
       archive's .db but not its companions — be silently overwritten by the
       sidecar rename below, which is the same clobber bug one level down. */
    const taken = (p: string): boolean =>
      fs.existsSync(p) || fs.existsSync(p + '-wal') || fs.existsSync(p + '-shm');
    let aside = `${base}-v${version}-mtplx.db`;
    for (let n = 2; taken(aside); n++) aside = `${base}-v${version}-mtplx.${n}.db`;
    fs.renameSync(file, aside);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, aside + suffix);
    }
    console.warn(`[db] schema v${version} found, expected v${SCHEMA_VERSION}; moved aside to ${aside}`);
  }
```

**3e.** Update `StoreOptions` and `RunInfo`:

```ts
export interface StoreOptions {
  path: string;
  enabled: boolean;
  retentionDays: number;
  /** Bodies age out ahead of metrics — see spec section 5.3. */
  transcriptRetentionDays: number;
}

export interface RunInfo {
  targetId: string;
  /** Integer ms, derived once at restart detection — see spec section 4.4. */
  startedAt: number;
  model: string | null;
  version: string | null;
  kvCacheDtype: string | null;
  turboquantMode: string | null;
  specDecodeMethod: string | null;
  engineType: string | null;
  contextWindow: number | null;
  /** Raw /health + /v1/status + build_info as observed at run start. */
  health: string;
}
```

Update `RunRow`, `RunSummary` and `RunDetail` to match these column names, and the `queryRuns` SELECT/mapping accordingly. `RunSummary.accept` is removed — there is no per-request accept rate any more; keep `decode` and `ttft`.

**3f.** Rewrite `upsertRun` to key on `(target_id, started_at)`:

```ts
  upsertRun(info: RunInfo, now: number): number | null {
    if (!this.db) return null;
    try {
      const existing = this.db
        .prepare('SELECT id FROM run WHERE target_id = ? AND started_at = ?')
        .get(info.targetId, info.startedAt) as { id: number } | undefined;
      if (existing) return existing.id;

      /* Close this target's open runs only — another target's run is unrelated
         and must not be ended by this one restarting. */
      this.db
        .prepare('UPDATE run SET ended_at = ? WHERE target_id = ? AND ended_at IS NULL AND started_at < ?')
        .run(now, info.targetId, info.startedAt);

      const res = this.db
        .prepare(
          `INSERT INTO run (target_id, started_at, detected_at, ended_at, model, version,
                            kv_cache_dtype, turboquant_mode, spec_decode_method,
                            engine_type, context_window, health)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          info.targetId, info.startedAt, now, info.model, info.version,
          info.kvCacheDtype, info.turboquantMode, info.specDecodeMethod,
          info.engineType, info.contextWindow, info.health
        );
      return Number(res.lastInsertRowid);
    } catch (err) {
      this.fail('upsertRun', err);
      return null;
    }
  }
```

**3g.** Add `targetId` to `insertGauge` and its `Store` interface entry:

```ts
  insertGauge(targetId: string, series: string, value: number | null, ts: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare('INSERT INTO gauge (ts, target_id, series, value) VALUES (?, ?, ?, ?)')
        .run(ts, targetId, series, value);
    } catch (err) {
      this.fail('insertGauge', err);
    }
  }
```

Update `queryGauges` to accept and filter on `targetId`, and `querySeries` likewise.

**3h.** Replace `insertRequest(record, runId, ts)` with a Phase-2-shaped writer plus a transcript writer. Nothing calls these in Phase 1; they exist so Phase 2 adds no schema change:

```ts
export interface RequestRow {
  requestId: string;
  targetId: string;
  runId: number | null;
  ts: number;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  ttftS?: number | null;
  requestElapsedS?: number | null;
  decodeTokS?: number | null;
  clientLabel?: string | null;
  toolCallCount?: number | null;
  userPreview?: string | null;
  outcome?: string | null;
  statusCode?: number | null;
  streamed?: boolean | null;
  finishReason?: string | null;
  /** False when the Δcount == 1 join was ambiguous — see spec section 4.2. */
  engineJoined?: boolean | null;
}
```

```ts
  insertRequestRow(r: RequestRow): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO request
             (request_id, target_id, run_id, ts, model, prompt_tokens, completion_tokens,
              ttft_s, request_elapsed_s, decode_tok_s, client_label, tool_call_count,
              user_preview, outcome, status_code, streamed, finish_reason, engine_joined)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          r.requestId, r.targetId, r.runId, r.ts, r.model ?? null,
          num(r.promptTokens), num(r.completionTokens), num(r.ttftS),
          num(r.requestElapsedS), num(r.decodeTokS), txt(r.clientLabel),
          num(r.toolCallCount), txt(r.userPreview), txt(r.outcome),
          num(r.statusCode), flag(r.streamed), txt(r.finishReason),
          flag(r.engineJoined)
        );
    } catch (err) {
      this.fail('insertRequestRow', err);
    }
  }

  insertTranscript(
    requestId: string,
    messages: string | null,
    responseText: string | null,
    tools: string | null,
    truncated: boolean
  ): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO transcript (request_id, ts, messages, response_text, tools, truncated)
           SELECT ?, ts, ?, ?, ?, ? FROM request WHERE request_id = ?`
        )
        .run(requestId, messages, responseText, tools, truncated ? 1 : 0, requestId);
    } catch (err) {
      this.fail('insertTranscript', err);
    }
  }
```

Note `insertTranscript` takes `ts` from the parent `request` row via `SELECT`, so the two can never disagree — which is what the independent prune below relies on.

Also implement `gaugeNames` on `SqliteStore` (controller ruling R1 — it is declared on the interface here, so it must be implemented here or `implements Store` will not compile):

```ts
  gaugeNames(targetId: string): string[] {
    if (!this.db) return [];
    try {
      return (
        this.db
          .prepare('SELECT DISTINCT series FROM gauge WHERE target_id = ? ORDER BY series')
          .all(targetId) as { series: string }[]
      ).map(r => r.series);
    } catch (err) {
      this.fail('gaugeNames', err);
      return [];
    }
  }
```

Update the `Store` interface itself to match, or none of this is callable: remove `insertRequest`, and add

```ts
  insertRequestRow(r: RequestRow): void;
  insertTranscript(
    requestId: string,
    messages: string | null,
    responseText: string | null,
    tools: string | null,
    truncated: boolean
  ): void;
  gaugeNames(targetId: string): string[];
  insertGauge(targetId: string, series: string, value: number | null, ts: number): void;
  querySeries(targetId: string, names: string[], from: number, to: number, buckets: number): SeriesResult;
  queryGauges(targetId: string, names: string[], from: number, to: number, buckets: number): SeriesResult;
```

**3i.** Extend `prune`:

```ts
  prune(now: number): void {
    if (!this.db) return;
    const cutoff = now - this.options.retentionDays * 86_400_000;
    const bodyCutoff = now - this.options.transcriptRetentionDays * 86_400_000;
    try {
      /* Bodies first and on their own clock — they are the bulk of the disk and
         are useful for days, not the month the numbers are kept for. */
      this.db.prepare('DELETE FROM transcript WHERE ts < ?').run(bodyCutoff);
      this.db.prepare('DELETE FROM request WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM gauge WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM run WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoff);
    } catch (err) {
      this.fail('prune', err);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/db.test.ts`
Expected: PASS. `npm run typecheck` will still fail — `metricsPoller.ts` and `healthPoller.ts` call the old signatures. That is expected and is fixed in Tasks 4–6; do not patch them here.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "feat: schema v2 for rapid-mlx, with set-aside instead of migration"
```

---

## Task 4: Run tracking from uptime

**Files:**
- Create: `server/runTracker.ts`
- Test: `server/runTracker.test.ts`

**Interfaces:**
- Consumes: `PromScrape`, `findSample` from `./promParse`; `detectRestart` from `./promSeries`; `Store`, `RunInfo` from `./db`.
- Produces:
  - `interface RunTrackerDeps { targetId: string; store: Pick<Store, 'upsertRun'> }`
  - `class RunTracker` with `observe(scrape: PromScrape, health: unknown, contextWindow: number | null, now: number): void`, `getRunId(): number | null`, `getModel(): string | null`, `getVersion(): string | null`, `didRestart(): boolean`

**Background you need — read this carefully, it is the subtlest part of Phase 1.** rapid-mlx has no pid and no start timestamp, so a restart must be inferred from `rapid_mlx_uptime_seconds`.

A bare "uptime went down" test is not enough, and controller ruling R9 amends this task accordingly. Consider: uptime reads 100 s, the dashboard's scrape then fails for two hours, and the server restarts at the start of that outage. The next successful scrape reads uptime 7200 — *greater* than 100 — so a decrease test sees nothing, and two hours of a brand-new process is attributed to the old run.

The robust signal is the **derived origin**, `now - uptime * 1000`. Declare a restart when either:
- uptime decreased since the last observation (the ordinary, immediate case), **or**
- the derived origin lands more than 30 s *after* the previous successful observation — the process demonstrably started after we last looked, which is exactly the long-gap case above.

30 s sits far above scrape jitter (milliseconds) and far below any real restart's jump. One false positive is accepted and documented: if the host sleeps and rapid-mlx measures uptime on a monotonic clock that excludes sleep, waking looks like an origin jump and mints one spurious run boundary. That costs an extra `run` row and splits one run in two — strictly better than the opposite failure, which silently merges two different processes into one run.

The naive implementation recomputes `startedAt = now - uptime * 1000` on every scrape and upserts. That is a bug. `uptime_seconds` has millisecond precision (`3590.942`) and scrape timing jitters by a few ms, so the derived origin *wanders*, and the `UNIQUE(target_id, started_at)` index mints a brand-new `run` row roughly once per second. Compute `startedAt` **once**, at the moment a restart is detected (and once at first observation), then hold it until the next detection.

Config values come from gauges with one series per possible value and `1` on the active one — `kv_cache_dtype{dtype="bf16"} 1` with `int8`/`int4` at `0`. Read them by finding the labelled series whose value is `1`.

- [ ] **Step 1: Write the failing test**

Create `server/runTracker.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus } from './promParse';
import { RunTracker } from './runTracker';
import type { RunInfo } from './db';

const fixture = (name: string) =>
  parsePrometheus(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

/** Records upsertRun calls and hands back increasing ids. */
function fakeStore() {
  const calls: RunInfo[] = [];
  let next = 1;
  return {
    calls,
    upsertRun(info: RunInfo): number | null {
      calls.push(info);
      return next++;
    },
  };
}

/** A scrape with a chosen uptime, otherwise identical to the real fixture. */
function scrapeWithUptime(uptimeS: number) {
  const text = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'rapid-mlx-0.13.4-after-first-request.txt'), 'utf8')
    .replace(/^rapid_mlx_uptime_seconds .*$/m, `rapid_mlx_uptime_seconds ${uptimeS}`);
  return parsePrometheus(text);
}

test('first observation creates a run', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].targetId, 'qwen');
  assert.equal(store.calls[0].startedAt, 900_000);
  assert.equal(t.getRunId(), 1);
});

/* THE TRAP. uptime has ms precision and scrape timing jitters, so a naive
   recompute derives a slightly different origin every poll and the unique
   index mints a new run every second. startedAt must be computed once and
   held. */
test('uptime drift does not mint new runs', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  const first = store.calls[0].startedAt;

  t.observe(scrapeWithUptime(101.001), {}, 262144, 1_001_000);
  t.observe(scrapeWithUptime(101.997), {}, 262144, 1_002_000);
  t.observe(scrapeWithUptime(103.004), {}, 262144, 1_003_000);

  assert.equal(store.calls.length, 1, 'drift should not create additional runs');
  assert.equal(t.getRunId(), 1);
  assert.equal(first, 900_000);
});

test('uptime going backwards starts a new run with a fresh origin', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(3600), {}, 262144, 5_000_000);
  assert.equal(store.calls.length, 1);

  t.observe(scrapeWithUptime(2), {}, 262144, 6_000_000);
  assert.equal(store.calls.length, 2, 'restart should create a run');
  assert.equal(store.calls[1].startedAt, 5_998_000);
  assert.equal(t.getRunId(), 2);
  assert.equal(t.didRestart(), true);
});

/* The case a bare uptime-decrease test cannot see: the restart happened during
   an outage longer than the new uptime, so uptime comes back HIGHER. */
test('a restart during a long scrape outage is still detected', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  assert.equal(store.calls.length, 1);

  /* Server restarted at t=1_100_000; we only look again two hours later. */
  t.observe(scrapeWithUptime(7200), {}, 262144, 8_300_000);
  assert.equal(store.calls.length, 2, 'restart across the gap was missed');
  assert.equal(store.calls[1].startedAt, 1_100_000);
  assert.equal(t.didRestart(), true);
});

/* The mirror case: the same long outage with NO restart must not invent one. */
test('a long scrape outage without a restart creates no new run', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  /* Ran continuously, so the origin stays at 900_000 either way. */
  t.observe(scrapeWithUptime(7300), {}, 262144, 8_200_000);
  assert.equal(store.calls.length, 1);
  assert.equal(t.didRestart(), false);
});

test('didRestart is false on a steady scrape', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  t.observe(scrapeWithUptime(101), {}, 262144, 1_001_000);
  assert.equal(t.didRestart(), false);
});

test('reads model and version from build_info', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(fixture('rapid-mlx-0.13.4-after-first-request.txt'), {}, 262144, 1_000_000);
  assert.equal(store.calls[0].version, '0.13.4');
  assert.equal(store.calls[0].model, 'mtplx-qwen38-27b-optimized-speed-fp16');
  assert.equal(t.getModel(), 'mtplx-qwen38-27b-optimized-speed-fp16');
});

/* These gauges emit one series per possible value with 1 on the active one. */
test('reads the active label out of one-hot config gauges', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(fixture('rapid-mlx-0.13.4-after-first-request.txt'), {}, 262144, 1_000_000);
  assert.equal(store.calls[0].kvCacheDtype, 'bf16');
  assert.equal(store.calls[0].turboquantMode, 'disabled');
});

test('picks up the differing family on the gemma backend', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'gemma', store });
  t.observe(fixture('rapid-mlx-0.13.4-gemma.txt'), {}, 262144, 1_000_000);
  assert.equal(store.calls[0].model, 'gemma-4-26b-qat-4bit');
  assert.equal(store.calls[0].specDecodeMethod, 'mtp');
});

test('carries engine_type through from /health', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), { engine_type: 'batched' }, 262144, 1_000_000);
  assert.equal(store.calls[0].engineType, 'batched');
});

test('archives health, status and build_info together', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), { status: 'idle' }, 262144, 1_000_000);
  const archived = JSON.parse(store.calls[0].health);
  assert.equal(archived.health.status, 'idle');
  assert.equal(archived.buildInfo.version, '0.13.4');
});

test('a scrape with no uptime gauge creates no run', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(parsePrometheus('rapid_mlx_requests_running 0\n'), {}, null, 1_000_000);
  assert.equal(store.calls.length, 0);
  assert.equal(t.getRunId(), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/runTracker.test.ts`
Expected: FAIL — `Cannot find module './runTracker'`.

- [ ] **Step 3: Write the implementation**

Create `server/runTracker.ts`:

```ts
import { findSample } from './promParse';
import type { PromScrape } from './promParse';
import { detectRestart } from './promSeries';
import type { Store, RunInfo } from './db';

export interface RunTrackerDeps {
  targetId: string;
  store: Pick<Store, 'upsertRun'>;
}

/** Value of the label `key` on the series of `name` whose value is 1.
 *  rapid-mlx emits config as one-hot gauges — kv_cache_dtype{dtype="bf16"} 1
 *  alongside int8/int4 at 0 — so the active setting is the labelled series
 *  carrying the 1, not a value to be read directly. */
function activeLabel(scrape: PromScrape, name: string, key: string): string | null {
  for (const s of scrape.samples) {
    if (s.name === name && s.value === 1 && s.labels[key] !== undefined) return s.labels[key];
  }
  return null;
}

/** First value seen for `key` across any series of `name`. Used for labels that
 *  are constant per process (the spec-decode method), where the value on the
 *  series is a counter and irrelevant. */
function anyLabel(scrape: PromScrape, name: string, key: string): string | null {
  for (const s of scrape.samples) {
    if (s.name === name && s.labels[key] !== undefined) return s.labels[key];
  }
  return null;
}

/** How far the derived origin must move before it counts as a restart rather
 *  than clock or scrape jitter. Jitter moves it by milliseconds; a restart
 *  moves it by the whole previous uptime. */
const RESTART_EPSILON_MS = 30_000;

export class RunTracker {
  private runId: number | null = null;
  private model: string | null = null;
  private version: string | null = null;
  /** Held stable between restarts — see the comment in observe(). */
  private startedAt: number | null = null;
  private prevUptimeS: number | null = null;
  /** `now` of the last successful observation — the reference the origin test
   *  compares against, so it holds across arbitrarily long scrape outages. */
  private lastObservedAt: number | null = null;
  private restarted = false;

  constructor(private readonly deps: RunTrackerDeps) {}

  observe(scrape: PromScrape, health: unknown, contextWindow: number | null, now: number): void {
    const uptime = findSample(scrape, 'rapid_mlx_uptime_seconds');
    const uptimeS = uptime && Number.isFinite(uptime.value) ? uptime.value : null;
    if (uptimeS === null) return; // nothing to key a run on

    const build = findSample(scrape, 'rapid_mlx_build_info');
    this.version = build?.labels.version ?? this.version;
    this.model = build?.labels.model ?? this.model;

    const derivedStart = Math.round(now - uptimeS * 1000);
    const isFirst = this.startedAt === null;

    /* Two independent restart signals (ruling R9). The decrease test catches
       the ordinary case immediately. The origin test catches what the decrease
       test cannot see at all: a restart during a scrape outage longer than the
       new uptime, where uptime returns HIGHER than we last saw it. If the
       process started after we last looked, it is a new process, whatever the
       uptime says. */
    const jumpedPastLastLook =
      this.lastObservedAt !== null && derivedStart > this.lastObservedAt + RESTART_EPSILON_MS;
    this.restarted = !isFirst && (detectRestart(this.prevUptimeS, uptimeS) || jumpedPastLastLook);

    this.prevUptimeS = uptimeS;
    this.lastObservedAt = now;

    /* Derive the origin ONLY on first sight and on restart, then hold it.
       uptime_seconds carries ms precision and scrape timing jitters, so
       recomputing every poll would wander the origin by a few ms and the
       UNIQUE(target_id, started_at) index would mint a new run every second. */
    if (isFirst || this.restarted) {
      this.startedAt = derivedStart;
    } else {
      return; // steady state: the run already exists, nothing to write
    }

    const info: RunInfo = {
      targetId: this.deps.targetId,
      startedAt: this.startedAt,
      model: this.model,
      version: this.version,
      kvCacheDtype: activeLabel(scrape, 'rapid_mlx_kv_cache_dtype', 'dtype'),
      turboquantMode: activeLabel(scrape, 'rapid_mlx_turboquant_mode', 'mode'),
      specDecodeMethod: anyLabel(scrape, 'rapid_mlx_spec_decode_attempts_total', 'method'),
      engineType:
        typeof (health as { engine_type?: unknown })?.engine_type === 'string'
          ? (health as { engine_type: string }).engine_type
          : null,
      contextWindow,
      health: JSON.stringify({
        health,
        buildInfo: { version: this.version, model: this.model, labels: build?.labels ?? {} },
      }),
    };

    this.runId = this.deps.store.upsertRun(info, now);
  }

  getRunId(): number | null { return this.runId; }
  getModel(): string | null { return this.model; }
  getVersion(): string | null { return this.version; }
  didRestart(): boolean { return this.restarted; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/runTracker.test.ts`
Expected: PASS, 12 tests.

The `uptime drift does not mint new runs` test is the one that matters. If it fails with `store.calls.length === 4`, the `startedAt` recompute guard is wrong.

- [ ] **Step 5: Commit**

```bash
git add server/runTracker.ts server/runTracker.test.ts
git commit -m "feat: derive run identity from uptime_seconds instead of pid"
```

---

## Task 5: Target and config shape

**Files:**
- Create: `server/targets.ts`
- Modify: `server/config.ts`, `.env.example`

**Interfaces:**
- Produces:
  - `interface Target { id: string; label: string; upstreamUrl: string; proxyPort: number | null }`
  - `function parseTargets(env: NodeJS.ProcessEnv): Target[]`
  - `config.targets: Target[]`, `config.scrapeTimeoutMs`, `config.gaugePersistIntervalMs`, `config.transcriptRetentionDays`

**Background you need:** Phase 1 runs a single target, but the *shape* is what Phase 3 extends, so it is a list from the start. `proxyPort` is parsed and carried but unused until Phase 2 — it is in `Target` now so Phase 3 does not have to reshape config again.

Spec §7: the scrape timeout and the proxy forward timeout are separate budgets. `MTPLX_TIMEOUT_MS: 2500` was correct for scraping and would truncate real generations if applied to a forward path. Only the scrape timeout exists in Phase 1; do not add a forward timeout with a default.

- [ ] **Step 1: Write the implementation**

Create `server/targets.ts`:

```ts
export interface Target {
  id: string;
  label: string;
  upstreamUrl: string;
  /** Capture-proxy listener port. Parsed now, unused until Phase 2. */
  proxyPort: number | null;
}

const DEFAULT_TARGETS = 'qwen=http://127.0.0.1:8000:8010';

const PORT_MIN = 1;
const PORT_MAX = 65535;

function warn(msg: string): void {
  console.warn(`[targets] ${msg}`);
}

/** Parses one `id=<url>[:proxyPort][|label]` entry, or null if it is malformed.
 *
 *  Rejecting an out-of-range proxy port matters more than it looks: port 0 is
 *  falsy, and `proxyPort` is laid down here for a later phase to consume. Code
 *  that reasonably writes `if (target.proxyPort)` would read an explicit `:0`
 *  as "no proxy configured" and silently skip a target the operator meant to
 *  proxy — a config error disguised as a default. */
function parseOne(chunk: string): Target | null {
  const [spec, label] = chunk.split('|');
  const eq = spec.indexOf('=');
  if (eq < 1) return null;

  const id = spec.slice(0, eq).trim();
  let rest = spec.slice(eq + 1).trim();
  if (!id || !rest) return null;

  /* A trailing :NNNN after the URL's own host:port is the proxy port. Both
     groups anchor on digits, so a bare http://host:8000 keeps its own port and
     an IPv6 literal's colons cannot produce a wrong split. */
  let proxyPort: number | null = null;
  const m = /^(https?:\/\/[^/]+:\d+):(\d+)$/.exec(rest);
  if (m) {
    const port = Number.parseInt(m[2], 10);
    if (port < PORT_MIN || port > PORT_MAX) {
      warn(`proxy port ${m[2]} in "${chunk}" is outside ${PORT_MIN}-${PORT_MAX}`);
      return null;
    }
    rest = m[1];
    proxyPort = port;
  }

  return { id, label: (label || id).trim(), upstreamUrl: rest.replace(/\/+$/, ''), proxyPort };
}

/** RAPID_MLX_TARGETS is a comma-separated list of
 *  `id=<upstreamUrl>[:<proxyPort>][|<label>]`, e.g.
 *    qwen=http://127.0.0.1:8000:8010|Qwen3.6-35B-A3B,gemma=http://127.0.0.1:8087:8011
 *  Phase 1 uses one entry; the list shape is what Phase 3 extends. */
export function parseTargets(env: NodeJS.ProcessEnv): Target[] {
  const raw = (env.RAPID_MLX_TARGETS || '').trim();
  const usingDefault = raw === '';
  const out: Target[] = [];

  for (const chunk of (usingDefault ? DEFAULT_TARGETS : raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const target = parseOne(chunk);
    if (target) out.push(target);
    /* Never drop a misconfigured entry silently. With more than one target a
       single typo would otherwise start the dashboard against a partial fleet
       and look entirely healthy doing it. */
    else warn(`ignoring malformed entry "${chunk}"`);
  }

  if (out.length) return out;
  /* Unreachable when usingDefault — DEFAULT_TARGETS is a constant that parses —
     but the guard makes the single-level recursion structural rather than a
     property a future edit could quietly break. */
  if (usingDefault) throw new Error('DEFAULT_TARGETS is malformed');
  warn(`no usable entries in RAPID_MLX_TARGETS; falling back to "${DEFAULT_TARGETS}"`);
  return parseTargets({});
}
```

Rewrite `server/config.ts`, keeping its existing `str`/`int`/`bool` helpers unchanged and replacing the exported object:

```ts
import { parseTargets } from './targets';

export const config = Object.freeze({
  targets: parseTargets(process.env),
  port: int('PORT', 8123),
  pollIntervalMs: int('POLL_INTERVAL_MS', 1000),
  /** Scrape budget only. Deliberately NOT reused for the Phase 2 forward path:
   *  gbrain does not time out local inference (see its
   *  test/ai/local-fetch-no-timeout.test.ts) and a cold-cache 35B MoE can run
   *  for minutes. See spec section 7. */
  scrapeTimeoutMs: int('SCRAPE_TIMEOUT_MS', 2500),
  ringSize: int('RING_SIZE', 120),
  logBufferSize: int('LOG_BUFFER_SIZE', 300),
  maxBackoffMs: int('MAX_BACKOFF_MS', 10000),
  dbPath: str('DB_PATH', 'data/history.db'),
  persistEnabled: bool('PERSIST_ENABLED', true),
  retentionDays: int('RETENTION_DAYS', 30),
  transcriptRetentionDays: int('TRANSCRIPT_RETENTION_DAYS', 7),
  pruneIntervalMs: int('PRUNE_INTERVAL_MS', 3600000),
  healthIntervalMs: int('HEALTH_INTERVAL_MS', 5000),
  /** Gauges persist far slower than they are scraped — see Task 7. */
  gaugePersistIntervalMs: int('GAUGE_PERSIST_INTERVAL_MS', 10000),
});
```

Rewrite `.env.example` to document `RAPID_MLX_TARGETS`, `SCRAPE_TIMEOUT_MS`, `TRANSCRIPT_RETENTION_DAYS` and `GAUGE_PERSIST_INTERVAL_MS`, and drop `MTPLX_URL`/`MTPLX_TIMEOUT_MS`.

- [ ] **Step 2: Write the test**

Create `server/targets.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets } from './targets';

test('defaults to a single qwen target on :8000', () => {
  const t = parseTargets({});
  assert.equal(t.length, 1);
  assert.deepEqual(t[0], {
    id: 'qwen', label: 'qwen', upstreamUrl: 'http://127.0.0.1:8000', proxyPort: 8010,
  });
});

test('parses several targets with labels', () => {
  const t = parseTargets({
    RAPID_MLX_TARGETS:
      'qwen=http://127.0.0.1:8000:8010|Qwen3.6-35B-A3B,gemma=http://127.0.0.1:8087:8011|Gemma 4',
  });
  assert.equal(t.length, 2);
  assert.equal(t[1].id, 'gemma');
  assert.equal(t[1].label, 'Gemma 4');
  assert.equal(t[1].upstreamUrl, 'http://127.0.0.1:8087');
  assert.equal(t[1].proxyPort, 8011);
});

/* A bare host:port URL must not have its own port eaten as a proxy port. */
test('a URL without a proxy port yields proxyPort null', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'a=http://127.0.0.1:8000' });
  assert.equal(t[0].upstreamUrl, 'http://127.0.0.1:8000');
  assert.equal(t[0].proxyPort, null);
});

test('strips a trailing slash from the upstream URL', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'a=http://127.0.0.1:8000/' });
  assert.equal(t[0].upstreamUrl, 'http://127.0.0.1:8000');
});

/** Captures console.warn for the duration of fn. */
function captureWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return lines;
}

test('falls back to the default when every entry is malformed, and says so', () => {
  let t: ReturnType<typeof parseTargets> = [];
  const warnings = captureWarnings(() => { t = parseTargets({ RAPID_MLX_TARGETS: 'garbage,,=,x=' }); });
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'qwen');
  assert.ok(warnings.some(w => w.includes('falling back')), 'fallback was silent');
});

/* A typo in one entry of a multi-target list must not quietly start the
   dashboard against half the fleet looking perfectly healthy. */
test('a malformed entry is dropped loudly, and its valid siblings survive', () => {
  let t: ReturnType<typeof parseTargets> = [];
  const warnings = captureWarnings(() => {
    t = parseTargets({ RAPID_MLX_TARGETS: 'good=http://127.0.0.1:8000:8010,badnoequals' });
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'good');
  assert.ok(warnings.some(w => w.includes('badnoequals')), 'skipped entry was not reported');
});

/* Port 0 is falsy, so a later `if (target.proxyPort)` would read an explicit
   :0 as "no proxy configured" — a config error wearing a default's clothes. */
test('an out-of-range proxy port is rejected rather than carried', () => {
  for (const bad of ['0', '99999']) {
    let t: ReturnType<typeof parseTargets> = [];
    const warnings = captureWarnings(() => {
      t = parseTargets({ RAPID_MLX_TARGETS: `a=http://127.0.0.1:8000:${bad},b=http://127.0.0.1:8087:8011` });
    });
    assert.deepEqual(t.map(x => x.id), ['b'], `proxy port ${bad} was accepted`);
    assert.ok(warnings.some(w => w.includes(bad)), `proxy port ${bad} was dropped silently`);
  }
});

test('valid boundary proxy ports are accepted', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'a=http://127.0.0.1:8000:1,b=http://127.0.0.1:8087:65535' });
  assert.deepEqual(t.map(x => x.proxyPort), [1, 65535]);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/targets.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 4: Commit**

```bash
git add server/targets.ts server/targets.test.ts server/config.ts .env.example
git commit -m "feat: target list config, split scrape timeout from forward timeout"
```

---

## Task 6: Simplify healthPoller

**Files:**
- Modify: `server/healthPoller.ts`

**Interfaces:**
- Produces: `start(target: Target): void`, `stop(): void`, `getHealth(): unknown`, `getStatus(): unknown`, `getContextWindow(): number | null`, `getPromptTps(): number | null`

**Background you need:** `healthPoller` currently owns run identity and writes gauges. Both move: run identity to `RunTracker` (Task 4, which has the uptime signal), gauge writes to `promScraper` (Task 7, which has every series). What remains is a low-frequency cache of the three JSON endpoints the scrape cannot supply: `/health` for `engine_type`, `/v1/status` for `prompt_tps` (the only prefill signal that exists), and `/v1/models` for `context_window`.

`/v1/models` is fetched once per run rather than every tick — `context_window` is a property of the loaded weights and does not change while a process lives.

- [ ] **Step 1: Rewrite the module**

Replace `server/healthPoller.ts` entirely:

```ts
import { config } from './config';
import type { Target } from './targets';

let target: Target | null = null;
let timer: NodeJS.Timeout | null = null;
let stopped = true;

let health: unknown = null;
let status: unknown = null;
let contextWindow: number | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), config.scrapeTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function pollOnce(): Promise<void> {
  const base = target?.upstreamUrl;
  if (base) {
    /* Settled, not raced: /v1/status failing must not blank out a good
       /health, and neither is worth a retry at this cadence. */
    const [h, s] = await Promise.allSettled([
      fetchJson(`${base}/health`),
      fetchJson(`${base}/v1/status`),
    ]);
    if (h.status === 'fulfilled') health = h.value;
    if (s.status === 'fulfilled') status = s.value;

    /* context_window belongs to the loaded weights, so it is fetched once and
       then only re-fetched if it is still unknown. */
    if (contextWindow === null) {
      try {
        const models = (await fetchJson(`${base}/v1/models`)) as {
          data?: { context_window?: unknown }[];
        };
        const cw = models?.data?.[0]?.context_window;
        if (typeof cw === 'number' && Number.isFinite(cw)) contextWindow = cw;
      } catch {
        /* absent until the server answers; harmless */
      }
    }
  }
  if (!stopped) timer = setTimeout(() => void pollOnce(), config.healthIntervalMs);
}

export function start(t: Target): void {
  target = t;
  stopped = false;
  void pollOnce();
}

export function stop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}

export function getHealth(): unknown { return health; }
export function getStatus(): unknown { return status; }
export function getContextWindow(): number | null { return contextWindow; }

/** The only prefill-rate signal rapid-mlx exposes. Instantaneous and
 *  server-wide — there is no per-request prefill rate (spec section 6). */
export function getPromptTps(): number | null {
  const v = (status as { prompt_tps?: unknown })?.prompt_tps;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
```

- [ ] **Step 2: Verify it compiles in isolation**

Run: `npx tsc --noEmit server/healthPoller.ts server/targets.ts server/config.ts 2>&1 | head`
Expected: no errors from `healthPoller.ts` itself. Whole-project `typecheck` still fails until Task 7 removes `metricsPoller.ts`.

- [ ] **Step 3: Commit**

```bash
git add server/healthPoller.ts
git commit -m "refactor: healthPoller caches JSON endpoints only, no longer owns runs"
```

---

## Task 7: The scraper

**Files:**
- Modify: `server/types.ts`
- Create: `server/promScraper.ts`
- Delete: `server/metricsPoller.ts`
- Test: `server/promScraper.test.ts`

**Interfaces:**
- Consumes: `parsePrometheus`, `findSample`; `seriesName`, `CounterState`; `RunTracker`; `Store`; `Target`; `healthPoller`.
- Produces: `start(target: Target, store: Store): void`, `stop(): void`, `getSnapshot(): StatePayload`, and the exported pure helper `deriveSamples(scrape, counters): { decode: number | null; ttft: number | null; completedDelta: number | null }`

**Background you need — the write-volume problem.** MTPLX wrote four gauge rows per second. rapid-mlx exposes 73–80 series; writing all of them at the 1 s poll interval is roughly 6.4 million rows a day, which is not viable at a 30-day retention.

Two suppressions, both with precedent in the code you are replacing (`metricsPoller.ts` gated tool-parse gauge writes on a signature for exactly this reason):
1. **Persist on a slower clock than you scrape.** Scrape at `pollIntervalMs` (1 s) so the live UI is responsive; persist at `gaugePersistIntervalMs` (10 s).
2. **Skip series whose value is unchanged since the last persisted write.** Most of these series sit at zero indefinitely.

**Counters versus gauges.** A counter's stored value is its *per-interval delta*, not its cumulative total — a cumulative counter graphed over time is a monotonic ramp that says nothing. A family is a counter if its declared type is `counter`, or if it is a histogram `_bucket`/`_sum`/`_count` component. Everything else stores raw. `CounterState.delta` returns `null` on the first observation and on a reset; skip the write in both cases rather than substituting a number.

**Ring samples** (spec §4.2 and §5.4): `decode` takes `model_decode_tokens_per_second_last`, pushed only when `requests_processed_total` actually advanced — otherwise the same completed request would be re-sampled every second and flatten the sparkline. `ttft` takes `Δttft_sum / Δttft_count` when `Δcount > 0`. Phase 1 has no `request` rows, so `/api/history/series` returns nothing and the range selector reads `/api/history/gauges` instead.

- [ ] **Step 1: Rewrite `server/types.ts` first**

Controller ruling R2: this moved here from Task 8 because `getSnapshot()` below returns the new shape, so the type must exist before the scraper compiles.

Delete `MetricsRecord`, `ToolParseCounters`, `MtplxMetricsResponse`, `HealthResponse`, `LogEntry` and the `log` block of `StatePayload`. Keep `RingBuffers`. Replace `StatePayload`:

```ts
import type { PersistStatus } from './db';

export interface RingBuffers {
  decode: (number | null)[];
  prefill: (number | null)[];
  ttft: (number | null)[];
  accept: (number | null)[];
}

/** Single payload shape for both the initial SSE 'snapshot' and every later
 *  'tick'. Sent in full, never diffed — broadcasts only happen on genuine
 *  change, so the payload size is not the bottleneck. */
export interface StatePayload {
  targetId: string | null;
  targetLabel: string | null;
  /** Whether the last /metrics scrape succeeded. */
  scrapeOk: boolean;
  /** Capture-proxy forward-path health. Always null in Phase 1 — there is no
   *  proxy yet. The two are independent: a failed scrape says nothing about
   *  whether inference is serving. */
  upstreamOk: boolean | null;
  lastOkAt: number | null;
  lastChangeAt: number | null;
  model: string | null;
  version: string | null;
  contextWindow: number | null;
  /** Every current sample, keyed by the same series name used in the gauge
   *  table, so the client never reimplements the parser. */
  series: Record<string, number>;
  /** Raw /v1/status body, for the queue and memory cards. */
  status: unknown;
  rings: RingBuffers;
  ringSize: number;
  persist: PersistStatus;
}
```


- [ ] **Step 2: Write the failing test**

Create `server/promScraper.test.ts`. This tests the pure derivation helper only; the poll loop is covered by running the real thing in Task 8's verification.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus } from './promParse';
import { CounterState } from './promSeries';
import { deriveSamples } from './promScraper';

const read = (n: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

const COLD = read('rapid-mlx-0.13.4-cold.txt');
const AFTER = read('rapid-mlx-0.13.4-after-first-request.txt');

test('a cold scrape yields no samples at all', () => {
  const c = new CounterState();
  const d = deriveSamples(parsePrometheus(COLD), c);
  assert.equal(d.decode, null);
  assert.equal(d.ttft, null);
  assert.equal(d.completedDelta, null); // first observation has no baseline
});

test('the first delta after a cold scrape yields the real request', () => {
  const c = new CounterState();
  deriveSamples(parsePrometheus(COLD), c); // establish the baseline
  const d = deriveSamples(parsePrometheus(AFTER), c);
  assert.equal(d.completedDelta, 1);
  assert.equal(d.decode, 36.726379);
  /* ttft_sum 0.393659 over ttft_count 1 */
  assert.ok(d.ttft !== null && Math.abs(d.ttft - 0.393659) < 1e-9);
});

/* _last holds the same value until another request completes. Re-sampling it
   every second would flatten the sparkline with duplicates. */
test('decode is not re-sampled while the completed counter is flat', () => {
  const c = new CounterState();
  deriveSamples(parsePrometheus(COLD), c);
  deriveSamples(parsePrometheus(AFTER), c);
  const again = deriveSamples(parsePrometheus(AFTER), c);
  assert.equal(again.completedDelta, 0);
  assert.equal(again.decode, null);
  assert.equal(again.ttft, null);
});

test('ttft is the mean over the interval when several requests complete', () => {
  const c = new CounterState();
  const base = parsePrometheus(
    'rapid_mlx_requests_processed_total 10\n' +
    'rapid_mlx_model_ttft_seconds_sum 1.0\n' +
    'rapid_mlx_model_ttft_seconds_count 10\n'
  );
  const next = parsePrometheus(
    'rapid_mlx_requests_processed_total 14\n' +
    'rapid_mlx_model_ttft_seconds_sum 3.0\n' +
    'rapid_mlx_model_ttft_seconds_count 14\n'
  );
  deriveSamples(base, c);
  const d = deriveSamples(next, c);
  assert.equal(d.completedDelta, 4);
  assert.equal(d.ttft, 0.5); // 2.0s over 4 requests
});

test('a counter reset yields nulls rather than a spike', () => {
  const c = new CounterState();
  deriveSamples(parsePrometheus(COLD), c);
  deriveSamples(parsePrometheus(AFTER), c);
  const restarted = deriveSamples(parsePrometheus(COLD), c); // counters back to 0
  assert.equal(restarted.completedDelta, null);
  assert.equal(restarted.decode, null);
  assert.equal(restarted.ttft, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promScraper.test.ts`
Expected: FAIL — `Cannot find module './promScraper'`.

- [ ] **Step 4: Write the implementation**

Create `server/promScraper.ts`:

```ts
import { config } from './config';
import { broadcastTick } from './sse';
import { parsePrometheus, findSample } from './promParse';
import type { PromScrape } from './promParse';
import { seriesName, CounterState } from './promSeries';
import { RunTracker } from './runTracker';
import * as healthPoller from './healthPoller';
import type { Store } from './db';
import type { Target } from './targets';
import type { RingBuffers, StatePayload } from './types';

const rings: RingBuffers = { decode: [], prefill: [], ttft: [], accept: [] };
const counters = new CounterState();
/** Last persisted value per series, so unchanged series are not rewritten. */
const lastPersisted = new Map<string, number | null>();

let target: Target | null = null;
let store: Store | null = null;
let runTracker: RunTracker | null = null;
let scrape: PromScrape | null = null;
let scrapeOk = false;
let lastOkAt: number | null = null;
let lastChangeAt: number | null = null;
let lastPersistAt = 0;
let consecutiveFailures = 0;
let pollTimer: NodeJS.Timeout | null = null;
let stopped = true;

function pushRing(ring: (number | null)[], v: number | null): void {
  ring.push(v);
  if (ring.length > config.ringSize) ring.shift();
}

function value(s: PromScrape, name: string): number | null {
  const found = findSample(s, name);
  return found && Number.isFinite(found.value) ? found.value : null;
}

/** Per-interval derivations for the sparkline rings. Pure over (scrape,
 *  counters); `counters` is mutated, which is what makes successive calls
 *  produce deltas. Exported for testing. */
export function deriveSamples(
  s: PromScrape,
  c: CounterState
): { decode: number | null; ttft: number | null; completedDelta: number | null } {
  const processed = value(s, 'rapid_mlx_requests_processed_total');
  const completedDelta = processed === null ? null : c.delta('_processed', processed);

  const sum = value(s, 'rapid_mlx_model_ttft_seconds_sum');
  const count = value(s, 'rapid_mlx_model_ttft_seconds_count');
  const dSum = sum === null ? null : c.delta('_ttft_sum', sum);
  const dCount = count === null ? null : c.delta('_ttft_count', count);

  /* No completed request in this interval means _last still holds the previous
     one; re-sampling it would fill the sparkline with duplicates. */
  const advanced = completedDelta !== null && completedDelta > 0;

  return {
    completedDelta,
    decode: advanced ? value(s, 'rapid_mlx_model_decode_tokens_per_second_last') : null,
    ttft: dSum !== null && dCount !== null && dCount > 0 ? dSum / dCount : null,
  };
}

/** True for families whose stored value must be a per-interval delta. */
function isCumulative(s: PromScrape, name: string): boolean {
  if (name.endsWith('_bucket') || name.endsWith('_sum') || name.endsWith('_count')) return true;
  const base = name.replace(/_(bucket|sum|count)$/, '');
  return s.families.get(name)?.type === 'counter' || s.families.get(base)?.type === 'histogram';
}

function persistGauges(s: PromScrape, now: number): void {
  if (!store || !target) return;
  if (now - lastPersistAt < config.gaugePersistIntervalMs) return;
  lastPersistAt = now;

  for (const sample of s.samples) {
    if (!Number.isFinite(sample.value)) continue;
    const name = seriesName(sample);

    let out: number | null;
    if (isCumulative(s, sample.name)) {
      out = counters.delta(`persist:${name}`, sample.value);
      if (out === null) continue; // first sight, or a reset — no honest delta
    } else {
      out = sample.value;
    }

    /* Most of these sit at a constant (usually zero) forever. Writing them
       every interval would be ~74 rows/persist for no information. */
    if (lastPersisted.get(name) === out) continue;
    lastPersisted.set(name, out);
    store.insertGauge(target.id, name, out, now);
  }

  const promptTps = healthPoller.getPromptTps();
  if (promptTps !== null && lastPersisted.get('prompt_tps') !== promptTps) {
    lastPersisted.set('prompt_tps', promptTps);
    store.insertGauge(target.id, 'prompt_tps', promptTps, now);
  }
}

async function pollOnce(): Promise<void> {
  const now = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), config.scrapeTimeoutMs);
    let text: string;
    try {
      const res = await fetch(`${target!.upstreamUrl}/metrics`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(t);
    }

    const s = parsePrometheus(text);
    const wasOk = scrapeOk;
    scrape = s;

    runTracker?.observe(s, healthPoller.getHealth(), healthPoller.getContextWindow(), now);
    /* A restart rebases every counter at once; dropping the baselines wholesale
       is cheaper and safer than letting 80 series each discover it separately. */
    if (runTracker?.didRestart()) {
      counters.reset();
      lastPersisted.clear();
    }

    const d = deriveSamples(s, counters);
    let changed = false;
    if (d.decode !== null || d.ttft !== null) {
      pushRing(rings.decode, d.decode);
      pushRing(rings.ttft, d.ttft);
      pushRing(rings.prefill, healthPoller.getPromptTps());
      pushRing(rings.accept, value(s, 'rapid_mlx_spec_decode_accept_ratio'));
      lastChangeAt = now;
      changed = true;
    }

    persistGauges(s, now);

    lastOkAt = now;
    scrapeOk = true;
    consecutiveFailures = 0;
    if (!wasOk) changed = true; // reconnection is always broadcast-worthy

    if (changed) broadcastTick(getSnapshot());
    scheduleNext(config.pollIntervalMs);
  } catch {
    consecutiveFailures++;
    const wasOk = scrapeOk;
    scrapeOk = false;
    if (wasOk) broadcastTick(getSnapshot()); // announce the outage immediately
    scheduleNext(
      Math.min(config.maxBackoffMs, config.pollIntervalMs * 2 ** Math.min(consecutiveFailures, 5))
    );
  }
}

function scheduleNext(delayMs: number): void {
  if (stopped) return;
  pollTimer = setTimeout(() => void pollOnce(), delayMs);
}

/** Flattened current values, keyed by series name, for the client to render
 *  without reimplementing the parser. */
function currentSeries(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!scrape) return out;
  for (const s of scrape.samples) {
    if (Number.isFinite(s.value)) out[seriesName(s)] = s.value;
  }
  return out;
}

export function getSnapshot(): StatePayload {
  return {
    targetId: target?.id ?? null,
    targetLabel: target?.label ?? null,
    scrapeOk,
    /* Phase 1 has no proxy, so there is nothing to report about the forward
       path. Phase 2 replaces this with the real listener state. */
    upstreamOk: null,
    lastOkAt,
    lastChangeAt,
    model: runTracker?.getModel() ?? null,
    version: runTracker?.getVersion() ?? null,
    contextWindow: healthPoller.getContextWindow(),
    series: currentSeries(),
    status: healthPoller.getStatus(),
    rings: {
      decode: [...rings.decode],
      prefill: [...rings.prefill],
      ttft: [...rings.ttft],
      accept: [...rings.accept],
    },
    ringSize: config.ringSize,
    persist: store ? store.status() : { enabled: false, ok: true, lastError: null },
  };
}

export function start(t: Target, s: Store): void {
  target = t;
  store = s;
  runTracker = new RunTracker({ targetId: t.id, store: s });
  stopped = false;
  void pollOnce();
}

export function stop(): void {
  stopped = true;
  if (pollTimer) clearTimeout(pollTimer);
}
```

- [ ] **Step 5: Delete the old poller and run the tests**

```bash
git rm server/metricsPoller.ts
node --disable-warning=ExperimentalWarning --import tsx --test server/promScraper.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add server/types.ts server/promScraper.ts server/promScraper.test.ts
git commit -m "feat: Prometheus scraper replaces the MTPLX metrics poller"
```

---

## Task 8: Payload and server wiring

**Files:**
- Modify: `server/server.ts`, `server/db.ts`

**Interfaces:**
- Produces: the `StatePayload` shape consumed by all four pages.

**Background you need:** `types.ts` was already rewritten in Task 7 (controller ruling R2 — the scraper's `getSnapshot()` returns the new `StatePayload`, so the type had to exist first). This task is server wiring only.

`/api/history/series` must keep its `Object.hasOwn` rejection — the reason is unchanged and is a real one (`in` walks the prototype chain, so `?names=constructor` would slip past and reach SQL). `/api/history/gauges` takes dynamic names because they are bound as parameters, and it now needs a `target` parameter and a discovery endpoint so the UI can populate a series picker without a hardcoded list.

- [ ] **Step 1: Rewire `server/server.ts`**

Swap the imports (`./promScraper` for `./metricsPoller`), pass `transcriptRetentionDays` into `createStore`, add `target` to the history handlers, add the discovery endpoint, and simplify startup now that `healthPoller` no longer establishes the run:

```ts
import * as scraper from './promScraper';
import * as healthPoller from './healthPoller';

const target = config.targets[0]; // Phase 1 is single-target

const store = createStore({
  path: path.isAbsolute(config.dbPath) ? config.dbPath : path.join(__dirname, '..', config.dbPath),
  enabled: config.persistEnabled,
  retentionDays: config.retentionDays,
  transcriptRetentionDays: config.transcriptRetentionDays,
});
```

Both history handlers gained a `targetId` first parameter in Task 3 and must now pass one:

```ts
/** Target for a history query. Falls back to the single configured target, so
 *  existing URLs without ?target= keep working. */
function queryTarget(q: Record<string, unknown>): string {
  return typeof q.target === 'string' && q.target ? q.target : target.id;
}

app.get('/api/history/series', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to, buckets, names } = parseRange(q, Object.keys(REQUEST_SERIES));
  // `in` walks the prototype chain (so `?names=constructor` would slip past a
  // `n in REQUEST_SERIES` check and reach querySeries, whose Object.hasOwn
  // guard would then throw and escape this handler as a 500). Object.hasOwn
  // here keeps that rejection at the HTTP boundary as the intended 400.
  const unknown = names.filter(n => !Object.hasOwn(REQUEST_SERIES, n));
  if (unknown.length) {
    res.status(400).json({
      error: `unknown series: ${unknown.join(', ')}`,
      known: Object.keys(REQUEST_SERIES),
    });
    return;
  }
  res.json(store.querySeries(queryTarget(q), names, from, to, buckets));
});

app.get('/api/history/gauges', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to, buckets, names } = parseRange(q, []);
  res.json(store.queryGauges(queryTarget(q), names, from, to, buckets));
});
```

```ts
/** Series present in the gauge table for a target. The set is discovered, not
 *  hardcoded — it differs by backend and grows after first traffic (59/73/80
 *  across the committed fixtures). Safe to expose dynamically because gauge
 *  names are bound as parameters, unlike REQUEST_SERIES. */
app.get('/api/history/gauge-names', (req, res) => {
  const t = typeof req.query.target === 'string' ? req.query.target : target.id;
  res.json({ target: t, names: store.gaugeNames(t) });
});
```

The backing `store.gaugeNames()` was implemented in Task 3 (controller ruling R1).

Replace the startup chain. `healthPoller` no longer establishes a run, so the await-then-start ordering and the `shuttingDown` guard it protected are no longer needed — but `healthPoller` must still start first so the scraper's first `observe()` has `engine_type` and `context_window` available:

```ts
healthPoller.start(target);
scraper.start(target, store);
```

Update `shutdown()` to call `scraper.stop()` and `healthPoller.stop()`, and the boot log line to name the target.

- [ ] **Step 2: Typecheck and run the whole suite**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean, all suites pass. Fix any remaining references to deleted MTPLX types.

- [ ] **Step 3: Verify against the real server**

```bash
npm run dev
```

Then, in another shell:

```bash
curl -s http://127.0.0.1:8123/api/metrics | head -c 400
```

Expected: JSON with `scrapeOk: true`, a non-null `model`, a populated `series` object, and `contextWindow: 262144`.

Let it run for ~40 seconds, then confirm gauges are being written and that suppression is working:

```bash
sqlite3 data/history.db "SELECT COUNT(*) AS rows, COUNT(DISTINCT series) AS series FROM gauge;"
sqlite3 data/history.db "SELECT target_id, started_at, model, version, kv_cache_dtype FROM run;"
```

Expected: a **single** `run` row (not one per second — if you see many, Task 4's `startedAt` guard regressed), `version` `0.13.4`, and a gauge row count far below `series × ticks` because unchanged series are skipped.

- [ ] **Step 4: Commit**

```bash
git add server/types.ts server/server.ts server/db.ts
git commit -m "feat: reshape StatePayload and wire the scraper into the server"
```

---

## Task 9: Dashboard hero and payload rewire

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: the `StatePayload` from Task 8 (`series`, `status`, `rings`, `scrapeOk`, `model`, `version`, `contextWindow`).

**Background you need:** There is no frontend test harness in this project and deliberately so — verification is loading the page against the real server. Rendering and formatting stay duplicated across the four HTML files; do not factor anything into a shared module.

Spec §6 / D5: the hero stops being speculative decoding, which reads zero on both backends because the MoE weights carry no MTP head. It becomes decode throughput, Metal memory and queue depth.

`renderSparks()` remains the **only** call site of `sparks.*.render()`. `applyPayload()` must call `renderSparks()`, never render rings itself — a direct call bypasses the range selector, so an SSE tick would silently overwrite a user's selected historical range with live data, with nothing obviously wrong in review.

- [ ] **Step 1: Replace the hero markup**

Replace the whole `<section class="card hero">` block with:

```html
    <section class="card hero">
      <h2>Throughput</h2>
      <div class="subtitle">Decode rate, unified-memory headroom and queue depth for the live rapid-mlx target</div>
      <div class="hero-grid">

        <div>
          <div class="hero-figure"><span id="hero-decode">—</span><span class="unit">tok / s</span></div>
          <div class="hero-label">decode rate of the most recently completed request, as measured by the engine</div>
          <div class="hero-stats">
            <div class="kv"><span class="k">Fastest seen</span><span class="v" id="h-decode-max">—</span></div>
            <div class="kv"><span class="k">TTFT (mean, interval)</span><span class="v" id="h-ttft">—</span></div>
            <div class="kv"><span class="k">Prefill rate</span><span class="v" id="h-prefill">—</span></div>
            <div class="kv"><span class="k">Requests completed</span><span class="v" id="h-completed">—</span></div>
            <div class="kv"><span class="k">Prompt tokens</span><span class="v" id="h-prompt-tok">—</span></div>
            <div class="kv"><span class="k">Completion tokens</span><span class="v" id="h-completion-tok">—</span></div>
          </div>
        </div>

        <div>
          <div class="hero-figure"><span id="hero-mem">—</span><span class="unit">GB active</span></div>
          <div class="hero-label">Metal unified memory held by the model — peak is the high-water mark for this run</div>
          <div class="hero-stats">
            <div class="kv"><span class="k">Peak</span><span class="v" id="h-mem-peak">—</span></div>
            <div class="kv"><span class="k">Cache</span><span class="v" id="h-mem-cache">—</span></div>
            <div class="kv"><span class="k">Running</span><span class="v" id="h-running">—</span></div>
            <div class="kv"><span class="k">Waiting</span><span class="v" id="h-waiting">—</span></div>
            <div class="kv"><span class="k">Uptime</span><span class="v" id="h-uptime">—</span></div>
            <div class="kv"><span class="k">Version</span><span class="v" id="h-version">—</span></div>
          </div>
        </div>

      </div>
    </section>
```

- [ ] **Step 2: Add the series accessors and rewrite `renderHero`**

Add near the other formatters:

```js
/* The payload's `series` map is keyed exactly like the gauge table, so the
   client never reimplements the parser. */
let series = {};
let version = null;
let contextWindow = null;

function sv(name) {
  const v = series[name];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/* index.html already has fmt(n, d), fmtInt(n), fmtCompact(n), fmtSec(s) and
   fmtAgo(ms). None take a unit suffix, which every stat row below wants, so
   add this one alongside them. Do not rename or change the existing five. */
function fmtNum(n, digits, suffix) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return n.toFixed(digits) + (suffix || '');
}
function fmtGB(bytes) {
  return bytes === null ? '—' : (bytes / 1e9).toFixed(2) + ' GB';
}
function fmtDuration(s) {
  if (s === null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
```

Replace `renderHero()`:

```js
function renderHero() {
  const decode = sv('model_decode_tokens_per_second_last');
  $('hero-decode').textContent = decode === null ? '—' : decode.toFixed(1);
  $('h-decode-max').textContent = fmtNum(sv('model_decode_tokens_per_second_max'), 1, ' tok/s');

  /* Mean over the interval, not a single request: TTFT has no _last gauge, so
     it is only ever Δsum/Δcount. See spec section 4.2. */
  const ring = rings.ttft || [];
  const lastTtft = [...ring].reverse().find(v => v !== null) ?? null;
  $('h-ttft').textContent = lastTtft === null ? '—' : (lastTtft * 1000).toFixed(0) + ' ms';

  const prefillRing = rings.prefill || [];
  const lastPrefill = [...prefillRing].reverse().find(v => v !== null) ?? null;
  $('h-prefill').textContent = fmtNum(lastPrefill, 1, ' tok/s');

  $('h-completed').textContent = fmtNum(sv('requests_processed_total'), 0, '');
  $('h-prompt-tok').textContent = fmtNum(sv('prompt_tokens_total'), 0, '');
  $('h-completion-tok').textContent = fmtNum(sv('completion_tokens_total'), 0, '');

  const active = sv('metal_active_memory_bytes');
  $('hero-mem').textContent = active === null ? '—' : (active / 1e9).toFixed(2);
  $('h-mem-peak').textContent = fmtGB(sv('metal_peak_memory_bytes'));
  $('h-mem-cache').textContent = fmtGB(sv('metal_cache_memory_bytes'));
  $('h-running').textContent = fmtNum(sv('requests_running'), 0, '');
  $('h-waiting').textContent = fmtNum(sv('requests_waiting'), 0, '');
  $('h-uptime').textContent = fmtDuration(sv('uptime_seconds'));
  $('h-version').textContent = version || '—';
}
```

- [ ] **Step 3: Rewrite `applyPayload`**

```js
function applyPayload(p) {
  /* scrapeOk and upstreamOk are independent: a failed scrape says nothing
     about whether inference is serving. Phase 1 has no proxy, so upstreamOk
     is always null and only the scrape drives the banner. */
  connected = p.scrapeOk;
  lastOkAt = p.lastOkAt;
  lastChangeAt = p.lastChangeAt;
  rings = p.rings;
  series = p.series || {};
  version = p.version;
  contextWindow = p.contextWindow;

  if (p.model) $('model-chip').textContent = p.model;
  $('f-ring').textContent = String(p.ringSize);

  if (!connected) {
    document.body.classList.add('disconnected');
    $('banner-time').textContent = lastOkAt ? clock(new Date(lastOkAt)) : '(no data received yet)';
  } else {
    document.body.classList.remove('disconnected');
  }

  renderAll(p);
  renderStatus();
  /* Never call sparks.*.render() from here — renderSparks() is the only call
     site, because it is what consults the range selector. A direct call would
     let a tick silently overwrite a selected historical range with live data. */
  renderSparks();
}
```

Update `renderAll(p)` to call the renderers that still exist. Delete `renderVerify()` and its `<section>` — spec §6, there is no equivalent for draft/verify-forward/verify-eval/accept times. Delete the `#depths` bar chart and its legend.

- [ ] **Step 4: Verify in the browser**

```bash
npm run dev
```

Open `http://127.0.0.1:8123/`. Expect a populated hero: non-zero Metal active/peak, a version chip reading `0.13.4`, an uptime, and `Running`/`Waiting` at 0.

Then drive one real request so the throughput half fills in:

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"mtplx-qwen38-27b-optimized-speed-fp16","messages":[{"role":"user","content":"Say hi."}],"max_tokens":16}' > /dev/null
```

Expect the decode figure, TTFT and completed count to update within ~1 s, and the decode sparkline to gain exactly one point — not one per second.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: throughput and memory hero, wired to the scrape payload"
```

---

## Task 10: Remaining and new cards

**Files:**
- Modify: `public/index.html`

**Background you need:** Spec §6. Four cards are rewired, one is rebuilt against a new source, one is dropped (done in Task 9), and four are new. The spec-decode card stays in the markup but self-hides while `spec_decode_attempts_total` is 0, so it lights up on its own if an MTP model is ever loaded again — rather than being deleted and needing rediscovery.

- [ ] **Step 1: Rewire the surviving cards**

- **Decode throughput / Time to first token** — already fed by the rings from Task 7. Change the TTFT card's subtitle to say the value is an interval mean, not a per-request measurement, so the number is not read as something it is not.
- **Context window** — rebuild against `contextWindow` (262144 from `/v1/models`) and the last request's prompt tokens. There is no per-request `context_len` under rapid-mlx, so this shows prompt-token occupancy, not KV occupancy. Say so in the subtitle.
- **KV cache** — repoint at the prefix cache:

```js
function renderCache() {
  const hits = sv('prefix_cache_hits_total');
  const misses = sv('prefix_cache_misses_total');
  const total = hits === null || misses === null ? null : hits + misses;
  $('c-hitrate').textContent = total ? ((hits / total) * 100).toFixed(1) + '%' : '—';
  $('c-hits').textContent = fmtNum(hits, 0, '');
  $('c-misses').textContent = fmtNum(misses, 0, '');
  $('c-saved').textContent = fmtNum(sv('prefix_cache_tokens_saved_total'), 0, ' tok');
  $('c-bytes').textContent = fmtGB(sv('prefix_cache_current_bytes'));
  $('c-cap').textContent = fmtGB(sv('prefix_cache_cap_bytes'));
  $('c-evictions').textContent = fmtNum(sv('prefix_cache_pressure_evictions_total'), 0, '');
}
```

- **Tool-call parsing** — rapid-mlx has no parse counters. Until the Phase 2 proxy can count real `tool_calls`, repoint this card at the structured-output health that does exist, and retitle it "Structured output": `response_format_strict_total`, `..._violations_total`, `..._repairs_attempted_total`, `..._repairs_succeeded_total`, `..._repairs_skipped_context_overflow_total`. Add a one-line note that per-request tool-call counts arrive with the capture proxy.

- [ ] **Step 2: Add the new cards**

Add four `<section class="card">` blocks following the existing markup idiom (`<h2>`, `.subtitle`, `.kv` rows), each with a matching `render*` function called from `renderAll`:

- **Queue** — `requests_running`, `requests_waiting`, `steps_executed_total`, `requests_cancelled_total`, `requests_cancelled_via_disconnect_total`.
- **Request outcomes** — `model_requests_total{outcome=succeeded|cancelled|failed}`, plus `repetition_loop_stops_total` and `repetition_loop_breaks_total` as a generation-quality signal.
- **Memory detail** — `metal_active_memory_bytes`, `metal_peak_memory_bytes`, `metal_cache_memory_bytes`, `metal_cap_violations_total`, `ubc_evicted_bytes_total{path_kind=safetensors}`.
- **KV checkpoints** — `kv_checkpoint_writes_total`, `..._loads_total`, `..._bytes`, `..._evictions_total`, `..._hook_errors_total`.

- [ ] **Step 3: Make the spec-decode card self-hiding**

Keep a spec-decode `<section id="card-specdec">` showing `spec_decode_attempts_total`, `spec_decode_accepts_total`, `spec_decode_accept_ratio`, `spec_decode_tokens_saved_total` and the suffix-decode equivalents, and gate it:

```js
/* Reads zero on both current backends — the MoE weights carry no MTP head.
   Hidden rather than deleted so it reappears by itself if an MTP model is
   loaded again, instead of needing to be rediscovered. */
function renderSpecDecode() {
  const attempts = sv('spec_decode_attempts_total');
  const suffix = sv('suffix_decode_verify_steps_total');
  const active = (attempts !== null && attempts > 0) || (suffix !== null && suffix > 0);
  $('card-specdec').hidden = !active;
  if (!active) return;
  $('sd-attempts').textContent = fmtNum(attempts, 0, '');
  $('sd-accepts').textContent = fmtNum(sv('spec_decode_accepts_total'), 0, '');
  $('sd-ratio').textContent = fmtNum(sv('spec_decode_accept_ratio'), 3, '');
  $('sd-saved').textContent = fmtNum(sv('spec_decode_tokens_saved_total'), 0, ' tok');
}
```

- [ ] **Step 4: Verify in the browser**

Reload `http://127.0.0.1:8123/`. Expect: the prefix-cache card showing a real hit rate after a couple of requests, the memory card matching `sqlite3 data/history.db "SELECT value FROM gauge WHERE series='metal_active_memory_bytes' ORDER BY ts DESC LIMIT 1"`, and the spec-decode card **absent** from the page. Confirm no console errors.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: prefix cache, queue, memory and outcome cards"
```

---

## Task 11: Page states, retirement and docs

**Files:**
- Modify: `public/log.html`, `public/detail.html`, `public/history.html`, `package.json`, `CLAUDE.md`, `README.md`
- Delete: `patches/` (whole directory), `scripts/mtplx-postupgrade.sh`

**Background you need:** `log.html` and `detail.html` have no data source until the Phase 2 proxy exists — rapid-mlx exposes no per-request identity, not even mid-flight. They must say so plainly rather than rendering as broken or empty, because an empty live log is indistinguishable from an idle server.

The MTPLX patch and `mtplx:postupgrade` existed to keep a patch applied across MTPLX upgrades. There is no MTPLX. Deleting them is not cleanup deferred to later — a script that repairs a package which is no longer installed is a live trap for whoever runs it next.

- [ ] **Step 1: Give log.html and detail.html an honest empty state**

In both, remove the `EventSource` wiring and the MTPLX-shaped render functions, and put a single explanatory panel in the feed's place:

```html
<section class="card wide">
  <h2>Request log unavailable</h2>
  <div class="subtitle">
    rapid-mlx exposes no per-request identity — no request id, no prompt preview and no
    transcript, not even for in-flight work (<code>/v1/status.requests</code> stays empty
    while <code>num_running</code> is 1). Per-request history returns with the capture
    proxy in Phase&nbsp;2.
  </div>
  <p class="muted">
    Aggregate throughput, latency, cache and memory metrics are live on the
    <a href="/">dashboard</a>.
  </p>
</section>
```

Keep both pages' CSS token blocks in sync with `index.html` per the standing convention.

- [ ] **Step 2: Point history.html at gauges**

`history.html` currently reads `/api/history/series`, which returns nothing in Phase 1 because no `request` rows exist. Repoint its charts at `/api/history/gauges` with the series discovered from `/api/history/gauge-names`, and add a one-line note that per-request series return in Phase 2. Leave its forked `makeSpark()` with the restart-marker overlays alone — that fork is deliberate.

- [ ] **Step 3: Delete the MTPLX artifacts**

```bash
git rm -r patches
git rm scripts/mtplx-postupgrade.sh
```

Controller ruling R4: the working tree is already clean — commit `da15677` preserved the in-progress patch edits and the `.bak` files in history before this plan started, precisely so this deletion loses nothing. If `git rm` reports local modifications, stop and tell the controller rather than forcing with `-f`.

Remove the `mtplx:postupgrade` entry from `package.json` `scripts`, and update its `description` to describe a rapid-mlx dashboard.

- [ ] **Step 4: Update the docs**

In `CLAUDE.md`, rewrite: the "What this is" opening (rapid-mlx Prometheus, not MTPLX MTP), the running/testing block (drop `mtplx:postupgrade`, add the new test files), the Architecture module list (`promParse`/`promSeries`/`runTracker`/`promScraper`/`targets` in, `metricsPoller` out), the Data model section (Prometheus aggregates, not `{latest, recent[]}`), the SQLite section (schema v2, `target_id`, `transcript`, set-aside), and Connection/offline handling (`scrapeOk` vs `upstreamOk`).

Add these to "Conventions to preserve":

```markdown
- The metric family set is NOT fixed — 59 families on a cold server, 73 after
  first traffic, 80 on the gemma backend. Gauge series names are discovered from
  the scrape and stored as data; never hardcode a family list. `REQUEST_SERIES`
  stays a closed `Object.hasOwn` allowlist for the opposite reason: those names
  are interpolated into SQL.
- `run.started_at` is derived from `uptime_seconds` ONCE, at restart detection,
  and held stable. Recomputing it per scrape wanders the origin by a few ms
  (uptime is float seconds, scrape timing jitters) and the
  `UNIQUE(target_id, started_at)` index then mints a new run every second.
- Counter series are stored as per-interval deltas, never cumulative totals, and
  a decrease means a restart — persist null, never a negative or a raw total.
- Gauges persist on `GAUGE_PERSIST_INTERVAL_MS`, not the poll interval, and
  unchanged series are skipped. Writing ~74 series at 1 Hz is ~6.4M rows/day.
```

In `README.md`, replace the MTPLX framing and the `mtplx:postupgrade` section, document the new env vars, and state plainly that the live log and detail pages return in Phase 2.

- [ ] **Step 5: Final verification**

```bash
npm run typecheck
npm test
npm run build
npm run dev
```

Then check every page loads without console errors: `/`, `/log.html`, `/detail.html`, `/history.html`. Confirm `grep -ri mtplx server/ public/ package.json` returns only intentional historical references (the set-aside filename and the docs' change notes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: retire MTPLX artifacts, document the rapid-mlx architecture"
```

---

## Done when

- `npm test` passes: `promParse` (13), `promSeries` (15), `runTracker` (12), `targets` (9), `promScraper` (5), `db` (existing plus 8 new).
- `npm run typecheck` and `npm run build` are clean.
- The dashboard shows live throughput, memory, queue, prefix-cache and outcome data against the real `:8000` server.
- Exactly one `run` row exists after several minutes of uptime.
- `gauge` row growth is far below `series count × ticks`, confirming both suppressions work.
- No file outside the docs references MTPLX.

## Not in this plan

- The capture proxy, `transcript` writes, `request` rows, and the restored log/detail pages — **Phase 2**.
- The second (gemma) target, the target selector, and `history.html`'s second axis — **Phase 3**. The `target_id` columns and the `Target` list shape exist now so neither needs a schema change.
