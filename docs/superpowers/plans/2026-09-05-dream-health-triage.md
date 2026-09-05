# Dream-health triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gbrain's nightly-dream history queryable and put a triage view in front of it, so "did last night work?" is answered by opening a page rather than grepping a 192KB append-only text log.

**Architecture:** A pure parser turns the log into records; a separate, deliberately fallible attribution module assigns those records to sources; a schedule module derives expected nights from the LaunchAgent plist so a night that never fired becomes a row rather than an absence; an ingest module is the only thing that touches the filesystem or shells `git`. Storage extends the existing `data/history.db` via `SCHEMA_VERSION` 2 → 3 and the existing set-aside path. The view is a fifth framework-free page.

**Tech Stack:** TypeScript, Node ≥22.5, `node:sqlite` (`DatabaseSync`), `node:test` via `tsx`, express 4, framework-free HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-09-05-dream-health-triage-design.md`

## Global Constraints

- **No new runtime dependencies.** express is the only one; the parser is hand-rolled, matching `promParse.ts`'s stated reasoning.
- **Parsed identifiers are values, never SQL.** Phase names and source ids come from parsed text and are stored as column values bound as parameters. They must **not** be modelled on `REQUEST_SERIES`, whose closed `Object.hasOwn` allowlist exists precisely because those names are interpolated into SQL. (Spec §4.2.)
- **Never invent an alarm.** Any signal that cannot be established is reported as unknown/unavailable, never defaulted into a claim. Specifically: no schedule ⇒ no missed-night rows; failed git check ⇒ `unavailable`, never `none`. (Spec §7.)
- **Never take the dashboard down.** Ingest failures degrade the dream page only; the other four pages are unaffected. Ingest never throws at server start.
- **Offsets are byte offsets, not character offsets.** The log contains multibyte characters (`✓`, `✗`, `—`) on nearly every line. Use `Buffer.byteLength(text, 'utf8')`, never `String.length`.
- **Purity boundaries:** `dreamParse.ts` and `dreamAttribute.ts` have no I/O, no clock, no DB. `dreamSchedule.ts` takes an injected clock. Only `dreamIngest.ts` touches the outside world.
- **Test command:** `npm test` (`node --disable-warning=ExperimentalWarning --import tsx --test server/*.test.ts`). Typecheck: `npm run typecheck`.

## File Structure

**Create:**
- `server/dreamParse.ts` — pure log → records. Also parses `git log` output (pure text, same contract).
- `server/dreamParse.test.ts`
- `server/dreamAttribute.ts` — cycle-block → source, with provenance. Isolated because it is the most likely thing to be wrong.
- `server/dreamAttribute.test.ts`
- `server/dreamSchedule.ts` — plist → expected nights → missed-night derivation. Injected clock.
- `server/dreamSchedule.test.ts`
- `server/dreamIngest.ts` — the only I/O module: reads log, shells git, writes via store.
- `server/dreamIngest.test.ts`
- `server/fixtures/dream/*.txt` — five committed log excerpts (Task 1 and Task 2).
- `public/dream.html` — the triage page.

**Modify:**
- `server/db.ts` — `SCHEMA_VERSION` 2 → 3, four tables, dream store methods, set-aside archive naming fix.
- `server/db.test.ts` — dream store coverage.
- `server/server.ts` — two routes, isolated into Task 7. The rapid-mlx tasks that were going to rewrite this file have already landed and this branch is cut from them (spec §11), so the collision is retired; the isolation stands because it keeps the edit to two handlers.
- `public/index.html`, `public/log.html`, `public/history.html` — one nav link each (Task 8). **These three have uncommitted modifications in the sibling `rapid-mlx-prometheus` worktree.** Editing them here is expected to conflict when that work is committed; this was accepted deliberately. Keep the edit to the single nav line so the conflict is trivial to resolve.

---

### Task 1: Dream log parser

Pure text → records. No attribution yet: blocks come back with `sourceId: null`.

**Files:**
- Create: `server/dreamParse.ts`
- Create: `server/dreamParse.test.ts`
- Create: `server/fixtures/dream/completed-run.txt`
- Create: `server/fixtures/dream/warned-run.txt`
- Create: `server/fixtures/dream/truncated-run.txt`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseDreamLog(text: string): DreamParseResult`, `parseDreamCommits(gitLog: string): Map<string, string>`, and the types `DreamMark`, `DreamItemFailure`, `DreamPhaseLine`, `DreamCycleBlock`, `DreamRunRecord`, `DreamParseResult`.

- [ ] **Step 1: Capture the three fixtures**

Take real excerpts from `~/.gbrain/dream-nightly.log`. Each fixture is one complete run: the `starting` line through to the line before the next `starting`.

```bash
mkdir -p server/fixtures/dream
LOG=~/.gbrain/dream-nightly.log
# completed: a run ending in "done (dream exit=0)"
awk '/Sun Aug 30.*starting/,/Sun Aug 30.*done \(dream exit=0\)/' "$LOG" > server/fixtures/dream/completed-run.txt
# warned: WARN rc=143, commits present, no done line
awk 'NR>=2774' "$LOG" > server/fixtures/dream/warned-run.txt
# truncated: stops dead — no WARN, no commit, no done
awk 'NR>=2653 && NR<2774' "$LOG" > server/fixtures/dream/truncated-run.txt
wc -l server/fixtures/dream/*.txt
```

Verify by eye: `completed-run.txt` ends with `done (dream exit=0)`; `warned-run.txt` contains `WARN: global pass failed (rc=143)` and `[dream-nightly:commit]` lines but no `done`; `truncated-run.txt` ends mid-source with none of the three.

Then write `server/fixtures/dream/README.md`:

```markdown
# Dream log fixtures

Real excerpts from `~/.gbrain/dream-nightly.log`, one complete run each.

| File | Shape it pins |
|---|---|
| `completed-run.txt` | `starting` → phases → commit → `done (dream exit=0)` |
| `warned-run.txt` | `WARN … (rc=143)`, commits present, **no** `done` line |
| `truncated-run.txt` | Stops dead: no WARN, no commit, no `done` |
| `attribution-trap.txt` | A source's heavy block emitted *after* its own stamp (Task 2) |
| `missed-gap.txt` | Two runs spanning a night that never fired (Task 4) |

These are verbatim. Do not tidy them — the whitespace, the box-drawing marks and
the interleaved `Brain is healthy.` noise are all part of what the parser must
survive.
```

- [ ] **Step 2: Write the failing test**

Create `server/dreamParse.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog, parseDreamCommits } from './dreamParse';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dream', name), 'utf8');

test('reads a run boundary with its timestamp', () => {
  const r = parseDreamLog(fixture('completed-run.txt'));
  assert.equal(r.runs.length, 1);
  assert.equal(new Date(r.runs[0].startedAt).getFullYear(), 2026);
  assert.equal(r.runs[0].termination, 'completed');
  assert.equal(r.runs[0].exitCode, 0);
});

test('a warned run has an rc, commits, and no end timestamp', () => {
  const [run] = parseDreamLog(fixture('warned-run.txt')).runs;
  assert.equal(run.termination, 'warned');
  assert.equal(run.globalPassRc, 143);
  assert.equal(run.endedAt, null);
  assert.ok(run.committedShas.size > 0, 'commit lines should be captured');
});

test('a truncated run has no rc, no commits, no end', () => {
  const [run] = parseDreamLog(fixture('truncated-run.txt')).runs;
  assert.equal(run.termination, 'truncated');
  assert.equal(run.globalPassRc, null);
  assert.equal(run.endedAt, null);
  assert.equal(run.committedShas.size, 0);
});

test('captures the ordered source list', () => {
  const [run] = parseDreamLog(fixture('completed-run.txt')).runs;
  assert.ok(run.sources.length >= 2);
  assert.equal(run.sources[0], 'default');
});

test('parses phase marks and keeps the raw text', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Dream cycle (partial) in 1.4s:',
    '  ✓ lint        0 fix(es) applied; 335 non-fixable (informational)',
    '  - enrich_thin  cycle.enrich_thin.enabled=false (default OFF)',
    '  ! extract_facts  extract_facts skipped: 5 legacy v0.31 facts pending fence backfill',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  assert.equal(run.cycles.length, 1);
  assert.equal(run.cycles[0].durationS, 1.4);
  const marks = run.cycles[0].phases.map((p) => `${p.mark}:${p.phase}`);
  assert.deepEqual(marks, ['ran:lint', 'skipped:enrich_thin', 'noop:extract_facts']);
  assert.match(run.cycles[0].phases[0].text, /335 non-fixable/);
});

test('attaches nested item failures to their phase', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Dream cycle (partial) in 812.4s:',
    '  ! extract_atoms  extract_atoms: 124 atoms from 2/27 transcripts + 49/50 pages (1 failed)',
    '      ✗ career-ops/by-company/n8n: malformed model output: unparseable JSON array',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  const phase = run.cycles[0].phases[0];
  assert.equal(phase.failures.length, 1);
  assert.equal(phase.failures[0].slug, 'career-ops/by-company/n8n');
  assert.match(phase.failures[0].message, /unparseable JSON array/);
});

test('counts unrecognised lines instead of throwing', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '  ~ mystery_phase  something new the script started printing',
  ].join('\n');
  const r = parseDreamLog(text);
  assert.equal(r.unrecognisedCount, 1);
  assert.equal(r.runs.length, 1);
});

test('known noise lines are not counted as unrecognised', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Brain is healthy. 6 phase(s) checked in 0.5s.',
    'No stale pages — extraction is up to date.',
    '[dream-nightly:export] [export-career-ops] transformed: 421 ok',
  ].join('\n');
  assert.equal(parseDreamLog(text).unrecognisedCount, 0);
});

test('reports the byte offset of the last incomplete run', () => {
  const complete = fixture('completed-run.txt');
  const r = parseDreamLog(complete + '[dream-nightly] Sat Sep  6 07:05:06 EDT 2026 starting\n');
  assert.equal(r.lastIncompleteRunOffset, Buffer.byteLength(complete, 'utf8'));
});

test('a fully complete log has no incomplete-run offset', () => {
  const r = parseDreamLog(fixture('completed-run.txt'));
  assert.equal(r.lastIncompleteRunOffset, null);
});

test('parses dream auto-commit dates out of git log output', () => {
  const gitLog = [
    'e7fd46f 2026-09-05 dream: auto-commit gbrain writes 2026-09-05',
    'a89789a 2026-09-04 dream: auto-commit gbrain writes 2026-09-04',
    'e9f2ee5 2026-09-04 career-ops: delete stale hand-copied applications-tracker',
  ].join('\n');
  const m = parseDreamCommits(gitLog);
  assert.equal(m.get('2026-09-05'), 'e7fd46f');
  assert.equal(m.get('2026-09-04'), 'a89789a');
  assert.equal(m.size, 2, 'non-dream commits are ignored');
});

test('parses the whole real log with zero unrecognised lines', () => {
  for (const f of ['completed-run.txt', 'warned-run.txt', 'truncated-run.txt']) {
    assert.equal(parseDreamLog(fixture(f)).unrecognisedCount, 0, `${f} has unparsed lines`);
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './dreamParse'`.

- [ ] **Step 4: Write the implementation**

Create `server/dreamParse.ts`:

```typescript
/** gbrain dream-log parser. Pure: no I/O, no state, no clock.
 *
 *  Hand-rolled for the same reason promParse.ts is: the grammar is small and
 *  irregular, and the irregularities (a phase block that appears after its own
 *  source's stamp, marks drawn from a box-drawing character set) are exactly
 *  what a general-purpose parser would normalise away.
 *
 *  Attribution of blocks to sources is NOT done here — see dreamAttribute.ts.
 *  Blocks come back with sourceId null. */

export type DreamMark = 'ran' | 'skipped' | 'noop';
export type DreamTermination = 'completed' | 'warned' | 'truncated' | 'running';
export type DreamAttribution = 'stamped' | 'inferred' | 'unknown';

export interface DreamItemFailure {
  slug: string;
  message: string;
}

export interface DreamPhaseLine {
  mark: DreamMark;
  phase: string;
  text: string;
  failures: DreamItemFailure[];
}

export interface DreamCycleBlock {
  ordinal: number;
  durationS: number;
  phases: DreamPhaseLine[];
  /** Filled in by dreamAttribute.ts, not here. */
  sourceId: string | null;
  attribution: DreamAttribution;
  /** Index into DreamRunRecord.stamps of the stamp immediately preceding this
   *  block. -1 when the block precedes every stamp. Attribution needs this and
   *  it is only knowable while scanning. */
  precedingStampIndex: number;
}

export interface DreamRunRecord {
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  globalPassRc: number | null;
  termination: DreamTermination;
  /** Source ids in the order the run declared it would cycle them. */
  sources: string[];
  /** Source ids in the order they were actually stamped. */
  stamps: string[];
  /** source id -> sha, from [dream-nightly:commit] lines. */
  committedShas: Map<string, string>;
  cycles: DreamCycleBlock[];
  /** Byte offset of this run's `starting` line within the parsed text. */
  offset: number;
}

export interface DreamParseResult {
  runs: DreamRunRecord[];
  unrecognisedCount: number;
  unrecognisedSamples: string[];
  /** Byte offset of the last run that has no terminator, or null if every run
   *  in this text is terminated. Ingest rewinds here so a run that was still
   *  running at parse time is re-evaluated rather than frozen. */
  lastIncompleteRunOffset: number | null;
}

const RE_START = /^\[dream-nightly\]\s+(.+?)\s+starting$/;
const RE_DONE = /^\[dream-nightly\]\s+(.+?)\s+done \(dream exit=(-?\d+)\)$/;
const RE_WARN = /^\[dream-nightly\]\s+WARN: global pass failed \(rc=(-?\d+)\)$/;
const RE_SOURCES = /^\[dream-nightly\]\s+cycling sources:\s*(.*?)\s*$/;
const RE_STAMP = /^\[dream-nightly\]\s+stamped last_full_cycle_at for (\S+)$/;
const RE_COMMIT = /^\[dream-nightly:commit\]\s+(\S+)\s+committed\s+(\S+)$/;
const RE_CYCLE = /^Dream cycle \(partial\) in ([\d.]+)s:$/;
const RE_PHASE = /^ {2}([✓!-]) (\S+)\s{1,}(.*)$/;
const RE_FAILURE = /^ {4,}✗ ([^:]+):\s*(.*)$/;

/* Lines that are known, carry no record, and must not inflate the
   unrecognised count — that count is the format-drift canary and is worthless
   if ordinary noise lands in it. */
const NOISE = [
  /^Brain is healthy\./,
  /^No stale pages/,
  /^Dream cycle .* in [\d.]+s: *$/,
  /^ {2}totals: /,
  /^\[dream-nightly:(patch|export|mtplx|parity|commit)\]/,
  /^\[dream-nightly\] (global pass|cycling sources|stamped)/,
  /^\[dream-nightly\] (Dream|WARN)/,
  /^ *$/,
];

const MARKS: Record<string, DreamMark> = { '✓': 'ran', '-': 'skipped', '!': 'noop' };

export function parseDreamLog(text: string): DreamParseResult {
  const runs: DreamRunRecord[] = [];
  const unrecognisedSamples: string[] = [];
  let unrecognisedCount = 0;

  let run: DreamRunRecord | null = null;
  let cycle: DreamCycleBlock | null = null;
  let lastPhase: DreamPhaseLine | null = null;
  let offset = 0;

  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the \n we split on

    const start = RE_START.exec(line);
    if (start) {
      run = {
        startedAt: Date.parse(start[1]),
        endedAt: null,
        exitCode: null,
        globalPassRc: null,
        termination: 'running',
        sources: [],
        stamps: [],
        committedShas: new Map(),
        cycles: [],
        offset: lineOffset,
      };
      runs.push(run);
      cycle = null;
      lastPhase = null;
      continue;
    }

    if (!run) continue; // preamble before the first run boundary

    const done = RE_DONE.exec(line);
    if (done) {
      run.endedAt = Date.parse(done[1]);
      run.exitCode = Number(done[2]);
      run.termination = 'completed';
      cycle = null;
      lastPhase = null;
      continue;
    }

    const warn = RE_WARN.exec(line);
    if (warn) {
      run.globalPassRc = Number(warn[1]);
      continue;
    }

    const sources = RE_SOURCES.exec(line);
    if (sources) {
      run.sources = sources[1].split(/\s+/).filter(Boolean);
      continue;
    }

    const stamp = RE_STAMP.exec(line);
    if (stamp) {
      run.stamps.push(stamp[1]);
      continue;
    }

    const commit = RE_COMMIT.exec(line);
    if (commit) {
      run.committedShas.set(commit[1], commit[2]);
      continue;
    }

    const cyc = RE_CYCLE.exec(line);
    if (cyc) {
      cycle = {
        ordinal: run.cycles.length,
        durationS: Number(cyc[1]),
        phases: [],
        sourceId: null,
        attribution: 'unknown',
        precedingStampIndex: run.stamps.length - 1,
      };
      run.cycles.push(cycle);
      lastPhase = null;
      continue;
    }

    const fail = RE_FAILURE.exec(line);
    if (fail && lastPhase) {
      lastPhase.failures.push({ slug: fail[1].trim(), message: fail[2].trim() });
      continue;
    }

    const phase = RE_PHASE.exec(line);
    if (phase && cycle) {
      lastPhase = {
        mark: MARKS[phase[1]],
        phase: phase[2],
        text: phase[3].trim(),
        failures: [],
      };
      cycle.phases.push(lastPhase);
      continue;
    }

    if (NOISE.some((re) => re.test(line))) continue;

    unrecognisedCount++;
    if (unrecognisedSamples.length < 20) unrecognisedSamples.push(line);
  }

  /* A run that saw a WARN but never a `done` line got far enough for its trap
     to run; one that saw neither was killed outright. These have different
     causes and different remedies, so they stay distinct. */
  for (const r of runs) {
    if (r.termination !== 'running') continue;
    if (r.globalPassRc !== null || r.committedShas.size > 0) r.termination = 'warned';
    else r.termination = 'truncated';
  }

  const last = runs[runs.length - 1];
  const lastIncompleteRunOffset =
    last && last.termination !== 'completed' ? last.offset : null;

  return { runs, unrecognisedCount, unrecognisedSamples, lastIncompleteRunOffset };
}

/** `git log --format='%h %ad %s' --date=short` output → date → sha, keeping
 *  only the dream's own auto-commits. Pure; the shelling lives in ingest. */
export function parseDreamCommits(gitLog: string): Map<string, string> {
  const out = new Map<string, string>();
  const RE = /^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+dream: auto-commit gbrain writes\b/;
  for (const line of gitLog.split('\n')) {
    const m = RE.exec(line.trim());
    if (m && !out.has(m[2])) out.set(m[2], m[1]);
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all `dreamParse` tests green, existing suite unaffected.

If `termination` on the truncated fixture comes back `warned`, the fixture range caught a `[dream-nightly:commit]` line from the *previous* run — retrim it to start exactly at its own `starting` line.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add server/dreamParse.ts server/dreamParse.test.ts server/fixtures/dream/
git commit -m "feat: add dream log parser

Turns ~/.gbrain/dream-nightly.log into run records. Pure, fixture-driven,
mirroring promParse.ts. Distinguishes a run whose trap ran (WARN present)
from one killed outright (nothing after the last source), because those
have different causes.

Unrecognised lines are counted, never thrown on — that count is the
format-drift canary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Source attribution

The spec's §2.2 trap, isolated. This is the component most likely to be wrong.

**Files:**
- Create: `server/dreamAttribute.ts`
- Create: `server/dreamAttribute.test.ts`
- Create: `server/fixtures/dream/attribution-trap.txt`

**Interfaces:**
- Consumes: `DreamRunRecord`, `DreamCycleBlock`, `DreamAttribution` from `./dreamParse`.
- Produces: `attributeRun(run: DreamRunRecord): void` — mutates `run.cycles[].sourceId` and `.attribution` in place. Also exports `PER_SOURCE_PHASES` and `MIXED_PHASES` as `ReadonlySet<string>`.

- [ ] **Step 1: Capture the trap fixture**

```bash
LOG=~/.gbrain/dream-nightly.log
# The Sep 5 run: default's 1.4s block, its stamp, then default's 812.4s heavy
# block, then calendar's stamp.
awk 'NR>=2774' "$LOG" | sed -n '1,32p' > server/fixtures/dream/attribution-trap.txt
grep -nE 'Dream cycle|stamped last_full' server/fixtures/dream/attribution-trap.txt
```

Verify the output shows, in order: a `Dream cycle` line, `stamped … for default`, a second `Dream cycle` line, `stamped … for calendar`. If not, adjust the `sed` range until it does.

- [ ] **Step 2: Write the failing test**

Create `server/dreamAttribute.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog } from './dreamParse';
import { attributeRun } from './dreamAttribute';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dream', name), 'utf8');

test('THE TRAP: a heavy block after a stamp belongs to the stamped source', () => {
  const [run] = parseDreamLog(fixture('attribution-trap.txt')).runs;
  attributeRun(run);

  const heavy = run.cycles.find((c) => c.phases.some((p) => p.phase === 'extract_atoms'));
  assert.ok(heavy, 'fixture must contain an extract_atoms block');
  assert.equal(heavy.sourceId, 'default', 'must NOT be filed under calendar');
  assert.equal(heavy.attribution, 'inferred');
});

test('a first-group block belongs to the next source stamped', () => {
  const [run] = parseDreamLog(fixture('attribution-trap.txt')).runs;
  attributeRun(run);

  const light = run.cycles.find((c) => c.phases.some((p) => p.phase === 'lint'));
  assert.ok(light);
  assert.equal(light.sourceId, 'default');
  assert.equal(light.attribution, 'stamped');
});

test('an unknown phase mix is left unattributed rather than guessed', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default calendar',
    'Dream cycle (partial) in 1.0s:',
    '  ✓ some_future_phase  invented by a later gbrain release',
    '[dream-nightly] stamped last_full_cycle_at for default',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, null);
  assert.equal(run.cycles[0].attribution, 'unknown');
});

test('a block after the final stamp still attributes to that source', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    '[dream-nightly] stamped last_full_cycle_at for default',
    'Dream cycle (partial) in 9.0s:',
    '  ✓ consolidate  promoted 2 facts',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, 'default');
  assert.equal(run.cycles[0].attribution, 'inferred');
});

test('a first-group block with no stamp after it is unknown, not guessed', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default calendar',
    'Dream cycle (partial) in 1.0s:',
    '  ✓ lint  0 fix(es) applied',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, null);
  assert.equal(run.cycles[0].attribution, 'unknown');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './dreamAttribute'`.

- [ ] **Step 4: Write the implementation**

Create `server/dreamAttribute.ts`:

```typescript
/** Assigns cycle blocks to sources.
 *
 *  This is separated from dreamParse.ts because it is the component most
 *  likely to be wrong and most likely to need revision when gbrain changes its
 *  output. Keeping it apart means a change here cannot destabilise parsing.
 *
 *  WHY THIS IS NOT TRIVIAL. The intuitive rule — "a block belongs to the next
 *  `stamped last_full_cycle_at for X`" — is wrong. A source emits TWO blocks:
 *  a per-source group, then, after its own stamp, a heavy group. Observed
 *  2026-09-05:
 *
 *      Dream cycle (partial) in 1.4s:      <- default, per-source phases
 *      stamped … for default
 *      Dream cycle (partial) in 812.4s:    <- default AGAIN, heavy phases
 *      stamped … for calendar
 *
 *  Applying the intuitive rule files default's heaviest work under calendar:
 *  the busiest source looks idle and a trivial one looks enormous, silently.
 *
 *  The disambiguator is the phase set. The two groups are disjoint, so a
 *  block's own phases say which group it is, and therefore which stamp it
 *  belongs to. When the phases match neither group we return `unknown` rather
 *  than guessing — confidently-wrong attribution in an ops view gets acted on,
 *  which is worse than a visible gap. */

import type { DreamRunRecord } from './dreamParse';

/** Phases the per-source group emits, before that source is stamped. */
export const PER_SOURCE_PHASES: ReadonlySet<string> = new Set([
  'lint',
  'backlinks',
  'sync',
  'extract',
  'extract_facts',
  'recompute_emotional_weight',
]);

/** Phases the heavy group emits, AFTER its source is stamped. */
export const MIXED_PHASES: ReadonlySet<string> = new Set([
  'extract_atoms',
  'consolidate',
  'propose_takes',
  'conversation_facts_backfill',
  'enrich_thin',
  'schema-suggest',
]);

export function attributeRun(run: DreamRunRecord): void {
  for (const cycle of run.cycles) {
    const names = cycle.phases.map((p) => p.phase);
    const heavy = names.some((n) => MIXED_PHASES.has(n));
    const light = names.some((n) => PER_SOURCE_PHASES.has(n));

    /* Both groups in one block would mean gbrain merged them — the rule no
       longer holds and we must not pretend otherwise. */
    if (heavy === light) {
      cycle.sourceId = null;
      cycle.attribution = 'unknown';
      continue;
    }

    if (heavy) {
      // Belongs to the most recently stamped source.
      const idx = cycle.precedingStampIndex;
      if (idx >= 0 && idx < run.stamps.length) {
        cycle.sourceId = run.stamps[idx];
        cycle.attribution = 'inferred';
      } else {
        cycle.sourceId = null;
        cycle.attribution = 'unknown';
      }
      continue;
    }

    // Light: belongs to the NEXT source stamped after this block.
    const next = cycle.precedingStampIndex + 1;
    if (next < run.stamps.length) {
      cycle.sourceId = run.stamps[next];
      cycle.attribution = 'stamped';
    } else {
      cycle.sourceId = null;
      cycle.attribution = 'unknown';
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS. The first test is the one that matters — if `heavy.sourceId` is `calendar`, the rule has regressed to the naive form.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add server/dreamAttribute.ts server/dreamAttribute.test.ts server/fixtures/dream/attribution-trap.txt
git commit -m "feat: attribute dream cycle blocks to sources

A source emits two blocks and the second lands after its own stamp, so
the obvious 'block belongs to the next stamp' rule files the busiest
source's heaviest work under a trivial one. Disambiguates on the phase
set instead, and returns unknown rather than guessing when the phases
match neither group.

Pinned by attribution-trap.txt, a real Sep 5 excerpt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Schema v3 and dream store methods

**Files:**
- Modify: `server/db.ts` (`SCHEMA_VERSION`, `DDL`, `Store`, `SqliteStore`, `setAsideIfStale`)
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: `DreamRunRecord` from `./dreamParse`.
- Produces, added to the `Store` interface:
  - `insertDreamRun(run: DreamRunRecord, commitFromGit: string | null, commitSource: DreamCommitSource): number | null`
  - `queryDreamNights(limit: number): DreamNightRow[]`
  - `getDreamNight(date: string): DreamNightDetail | null`
  - `upsertDreamNight(date: string, expectedAt: number, runId: number | null, status: DreamNightStatus): void`
  - `dreamIngestOffset(): number` / `setDreamIngestOffset(offset: number): void`
  - Types `DreamCommitSource`, `DreamNightStatus`, `DreamNightRow`, `DreamNightDetail`.

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts` (keep the file's existing temp-dir helper — do not introduce a second one):

```typescript
import { parseDreamLog } from './dreamParse';
import { attributeRun } from './dreamAttribute';

test('stores a dream run and reads it back as a night', () => {
  const store = makeStore(); // existing helper: throwaway on-disk sqlite
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    'Dream cycle (partial) in 1.4s:',
    '  ✓ lint  0 fix(es) applied; 335 non-fixable',
    '  ! extract_facts  skipped: 5 legacy facts',
    '[dream-nightly] stamped last_full_cycle_at for default',
    '[dream-nightly] WARN: global pass failed (rc=143)',
    '[dream-nightly:commit] default committed e7fd46f',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);

  const id = store.insertDreamRun(run, 'e7fd46f', 'both');
  assert.ok(id !== null);

  store.upsertDreamNight('2026-09-05', Date.parse('2026-09-05T07:05:00'), id, 'warned');
  const nights = store.queryDreamNights(10);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].date, '2026-09-05');
  assert.equal(nights[0].status, 'warned');

  const detail = store.getDreamNight('2026-09-05');
  assert.ok(detail);
  assert.equal(detail.run?.globalPassRc, 143);
  assert.equal(detail.run?.commitSource, 'both');
  assert.equal(detail.phases.length, 2);
  assert.equal(detail.phases.find((p) => p.phase === 'extract_facts')?.mark, 'noop');
  store.close();
});

test('a missed night is a row with no run', () => {
  const store = makeStore();
  store.upsertDreamNight('2026-09-03', Date.parse('2026-09-03T07:05:00'), null, 'missed');
  const [night] = store.queryDreamNights(10);
  assert.equal(night.status, 'missed');
  assert.equal(night.runId, null);
  assert.equal(store.getDreamNight('2026-09-03')?.run, null);
  store.close();
});

test('nested item failures survive the round trip', () => {
  const store = makeStore();
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    '[dream-nightly] stamped last_full_cycle_at for default',
    'Dream cycle (partial) in 812.4s:',
    '  ! extract_atoms  124 atoms (1 failed)',
    '      ✗ career-ops/by-company/n8n: unparseable JSON array',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  const id = store.insertDreamRun(run, null, 'none');
  store.upsertDreamNight('2026-09-05', 0, id, 'warned');

  const phase = store.getDreamNight('2026-09-05')!.phases[0];
  assert.equal(phase.failureCount, 1);
  assert.deepEqual(JSON.parse(phase.failuresJson!)[0].slug, 'career-ops/by-company/n8n');
  store.close();
});

test('ingest offset round-trips and defaults to zero', () => {
  const store = makeStore();
  assert.equal(store.dreamIngestOffset(), 0);
  store.setDreamIngestOffset(4096);
  assert.equal(store.dreamIngestOffset(), 4096);
  store.close();
});

test('phase names are stored as values, not interpolated', () => {
  const store = makeStore();
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    'Dream cycle (partial) in 1.0s:',
    "  ✓ lint  0 fix(es); '); DROP TABLE dream_run; --",
    '[dream-nightly] stamped last_full_cycle_at for default',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  const id = store.insertDreamRun(run, null, 'none');
  store.upsertDreamNight('2026-09-05', 0, id, 'ok');
  assert.equal(store.queryDreamNights(10).length, 1, 'dream_run must still exist');
  store.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `store.insertDreamRun is not a function`.

- [ ] **Step 3: Write the implementation**

In `server/db.ts`:

1. Bump the version and add types near the top:

```typescript
export const SCHEMA_VERSION = 3;

export type DreamCommitSource = 'log' | 'git' | 'both' | 'none' | 'unavailable';
export type DreamNightStatus = 'ok' | 'warned' | 'truncated' | 'missed' | 'unknown';

export interface DreamNightRow {
  date: string;
  expectedAt: number;
  runId: number | null;
  status: DreamNightStatus;
  startedAt: number | null;
  committedSha: string | null;
  commitSource: DreamCommitSource | null;
}

export interface DreamPhaseRow {
  sourceId: string | null;
  attribution: string;
  phase: string;
  mark: string;
  text: string;
  failureCount: number;
  failuresJson: string | null;
}

export interface DreamNightDetail {
  night: DreamNightRow;
  run: {
    id: number;
    startedAt: number;
    endedAt: number | null;
    exitCode: number | null;
    globalPassRc: number | null;
    termination: string;
    committedSha: string | null;
    commitSource: DreamCommitSource;
  } | null;
  phases: DreamPhaseRow[];
}
```

2. Append to the `DDL` template string:

```sql
  CREATE TABLE IF NOT EXISTS dream_run (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    exit_code       INTEGER,
    global_pass_rc  INTEGER,
    termination     TEXT    NOT NULL,
    committed_sha   TEXT,
    commit_source   TEXT    NOT NULL,
    UNIQUE(started_at)
  );

  CREATE TABLE IF NOT EXISTS dream_source_cycle (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       INTEGER NOT NULL REFERENCES dream_run(id) ON DELETE CASCADE,
    ordinal      INTEGER NOT NULL,
    duration_s   REAL    NOT NULL,
    source_id    TEXT,
    attribution  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dream_cycle_run ON dream_source_cycle(run_id);

  CREATE TABLE IF NOT EXISTS dream_phase (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES dream_run(id) ON DELETE CASCADE,
    cycle_id      INTEGER REFERENCES dream_source_cycle(id) ON DELETE CASCADE,
    source_id     TEXT,
    phase         TEXT    NOT NULL,
    mark          TEXT    NOT NULL,
    raw_text      TEXT    NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    failures_json TEXT
  );
  CREATE INDEX IF NOT EXISTS dream_phase_run ON dream_phase(run_id);

  CREATE TABLE IF NOT EXISTS dream_night (
    date        TEXT    PRIMARY KEY,
    expected_at INTEGER NOT NULL,
    run_id      INTEGER REFERENCES dream_run(id) ON DELETE SET NULL,
    status      TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dream_ingest (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    offset INTEGER NOT NULL
  );
`;
```

3. Fix the set-aside archive name. Replace the two `-mtplx` literals in `setAsideIfStale`:

```typescript
    /* The archive name records which schema wrote it, not which product — v1
       was MTPLX-era but v2 is already rapid-mlx, so a hardcoded -mtplx suffix
       would mislabel every future set-aside. */
    let aside = `${base}-v${version}.db`;
    for (let n = 2; taken(aside); n++) aside = `${base}-v${version}.${n}.db`;
```

4. Add the methods to `SqliteStore`, each guarded by the class's existing `this.db` null check and `this.fail(op, err)` pattern:

```typescript
  insertDreamRun(
    run: DreamRunRecord,
    commitFromGit: string | null,
    commitSource: DreamCommitSource
  ): number | null {
    if (!this.db) return null;
    try {
      const shaFromLog = run.committedShas.get('default') ?? null;
      const sha = shaFromLog ?? commitFromGit;
      const info = this.db
        .prepare(
          `INSERT INTO dream_run
             (started_at, ended_at, exit_code, global_pass_rc, termination,
              committed_sha, commit_source)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(started_at) DO UPDATE SET
             ended_at = excluded.ended_at,
             exit_code = excluded.exit_code,
             global_pass_rc = excluded.global_pass_rc,
             termination = excluded.termination,
             committed_sha = excluded.committed_sha,
             commit_source = excluded.commit_source
           RETURNING id`
        )
        .get(
          run.startedAt,
          run.endedAt,
          run.exitCode,
          run.globalPassRc,
          run.termination,
          sha,
          commitSource
        ) as { id: number } | undefined;
      if (!info) return null;
      const runId = info.id;

      /* Re-ingesting a run that was `running` last pass must not double its
         rows, so children are replaced wholesale. */
      this.db.prepare('DELETE FROM dream_phase WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM dream_source_cycle WHERE run_id = ?').run(runId);

      const insCycle = this.db.prepare(
        `INSERT INTO dream_source_cycle (run_id, ordinal, duration_s, source_id, attribution)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      );
      const insPhase = this.db.prepare(
        `INSERT INTO dream_phase
           (run_id, cycle_id, source_id, phase, mark, raw_text, failure_count, failures_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const cycle of run.cycles) {
        const row = insCycle.get(
          runId,
          cycle.ordinal,
          cycle.durationS,
          cycle.sourceId,
          cycle.attribution
        ) as { id: number };
        for (const p of cycle.phases) {
          insPhase.run(
            runId,
            row.id,
            cycle.sourceId,
            p.phase,
            p.mark,
            p.text,
            p.failures.length,
            p.failures.length ? JSON.stringify(p.failures) : null
          );
        }
      }
      return runId;
    } catch (err) {
      this.fail('insertDreamRun', err);
      return null;
    }
  }

  upsertDreamNight(
    date: string,
    expectedAt: number,
    runId: number | null,
    status: DreamNightStatus
  ): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO dream_night (date, expected_at, run_id, status)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET
             expected_at = excluded.expected_at,
             run_id = excluded.run_id,
             status = excluded.status`
        )
        .run(date, expectedAt, runId, status);
    } catch (err) {
      this.fail('upsertDreamNight', err);
    }
  }

  queryDreamNights(limit: number): DreamNightRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT n.date, n.expected_at AS expectedAt, n.run_id AS runId, n.status,
                  r.started_at AS startedAt, r.committed_sha AS committedSha,
                  r.commit_source AS commitSource
             FROM dream_night n
             LEFT JOIN dream_run r ON r.id = n.run_id
            ORDER BY n.date DESC
            LIMIT ?`
        )
        .all(limit) as DreamNightRow[];
    } catch (err) {
      this.fail('queryDreamNights', err);
      return [];
    }
  }

  getDreamNight(date: string): DreamNightDetail | null {
    if (!this.db) return null;
    try {
      const night = this.db
        .prepare(
          `SELECT n.date, n.expected_at AS expectedAt, n.run_id AS runId, n.status,
                  r.started_at AS startedAt, r.committed_sha AS committedSha,
                  r.commit_source AS commitSource
             FROM dream_night n
             LEFT JOIN dream_run r ON r.id = n.run_id
            WHERE n.date = ?`
        )
        .get(date) as DreamNightRow | undefined;
      if (!night) return null;

      const run = night.runId
        ? (this.db
            .prepare(
              `SELECT id, started_at AS startedAt, ended_at AS endedAt,
                      exit_code AS exitCode, global_pass_rc AS globalPassRc,
                      termination, committed_sha AS committedSha,
                      commit_source AS commitSource
                 FROM dream_run WHERE id = ?`
            )
            .get(night.runId) as DreamNightDetail['run'])
        : null;

      const phases = night.runId
        ? (this.db
            .prepare(
              `SELECT source_id AS sourceId, phase, mark, raw_text AS text,
                      failure_count AS failureCount, failures_json AS failuresJson,
                      (SELECT attribution FROM dream_source_cycle c WHERE c.id = p.cycle_id)
                        AS attribution
                 FROM dream_phase p WHERE p.run_id = ? ORDER BY p.id`
            )
            .all(night.runId) as DreamPhaseRow[])
        : [];

      return { night, run: run ?? null, phases };
    } catch (err) {
      this.fail('getDreamNight', err);
      return null;
    }
  }

  dreamIngestOffset(): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare('SELECT offset FROM dream_ingest WHERE id = 1').get() as
        | { offset: number }
        | undefined;
      return row?.offset ?? 0;
    } catch (err) {
      this.fail('dreamIngestOffset', err);
      return 0;
    }
  }

  setDreamIngestOffset(offset: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO dream_ingest (id, offset) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET offset = excluded.offset`
        )
        .run(offset);
    } catch (err) {
      this.fail('setDreamIngestOffset', err);
    }
  }
```

Add all six signatures to the `Store` interface, and `import type { DreamRunRecord } from './dreamParse';` at the top.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -25`
Expected: PASS. Existing `db.test.ts` tests must still pass — the version bump changes the archive name only.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add server/db.ts server/db.test.ts
git commit -m "feat: schema v3 with dream run, cycle, phase and night tables

Adds dream storage alongside the rapid-mlx tables. Nights are rows, so a
night that never fired is recorded rather than inferred from absence, and
commit_source separates 'checked, no commit' from 'could not check'.

Also fixes the set-aside archive name: it recorded -mtplx unconditionally,
which was true when v1 was the only stale version but mislabels a v2
(rapid-mlx) database.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Schedule and missed nights

**Files:**
- Create: `server/dreamSchedule.ts`
- Create: `server/dreamSchedule.test.ts`
- Create: `server/fixtures/dream/missed-gap.txt`

**Interfaces:**
- Consumes: `DreamRunRecord` from `./dreamParse`; `DreamNightStatus` from `./db`.
- Produces:
  - `parseSchedule(plistXml: string): DreamSchedule | null`
  - `expectedNights(schedule: DreamSchedule, from: number, to: number): NightSlot[]`
  - `deriveNights(runs, schedule, now): DerivedNight[]`
  - Types `DreamSchedule { hour: number; minute: number }`, `NightSlot { date: string; expectedAt: number }`, `DerivedNight { date; expectedAt; runIndex: number | null; status: DreamNightStatus }`.

- [ ] **Step 1: Capture the gap fixture**

```bash
LOG=~/.gbrain/dream-nightly.log
# Two runs spanning skipped nights: Sep 2 start through Sep 5 start.
awk 'NR>=2653' "$LOG" > server/fixtures/dream/missed-gap.txt
grep -c 'starting' server/fixtures/dream/missed-gap.txt   # expect 2
```

- [ ] **Step 2: Write the failing test**

Create `server/dreamSchedule.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog } from './dreamParse';
import { parseSchedule, expectedNights, deriveNights } from './dreamSchedule';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dream', name), 'utf8');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.gbrain.dream-nightly</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict>
</dict></plist>`;

test('reads hour and minute out of the plist', () => {
  assert.deepEqual(parseSchedule(PLIST), { hour: 7, minute: 5 });
});

test('an unreadable plist yields null, never a default', () => {
  assert.equal(parseSchedule('<plist><dict></dict></plist>'), null);
  assert.equal(parseSchedule('not xml at all'), null);
});

test('expected nights are one per day at the scheduled time', () => {
  const from = Date.parse('2026-09-01T00:00:00');
  const to = Date.parse('2026-09-03T23:59:59');
  const slots = expectedNights({ hour: 7, minute: 5 }, from, to);
  assert.deepEqual(slots.map((s) => s.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(new Date(slots[0].expectedAt).getHours(), 7);
  assert.equal(new Date(slots[0].expectedAt).getMinutes(), 5);
});

test('a night with no run is missed', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const now = Date.parse('2026-09-05T12:00:00');
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, now);

  const byDate = new Map(nights.map((n) => [n.date, n]));
  assert.equal(byDate.get('2026-09-03')?.status, 'missed');
  assert.equal(byDate.get('2026-09-04')?.status, 'missed');
  assert.equal(byDate.get('2026-09-03')?.runIndex, null);
});

test('a night with a run takes that run status', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, Date.parse('2026-09-05T12:00:00'));
  const sep5 = nights.find((n) => n.date === '2026-09-05');
  assert.ok(sep5);
  assert.notEqual(sep5.status, 'missed');
  assert.equal(typeof sep5.runIndex, 'number');
});

test('NO SCHEDULE MEANS NO MISSED CLAIMS', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const nights = deriveNights(runs, null, Date.parse('2026-09-05T12:00:00'));
  assert.equal(nights.some((n) => n.status === 'missed'), false);
  assert.equal(nights.length, runs.length, 'only nights that actually ran');
});

test('today is not marked missed before its scheduled time', () => {
  const runs = parseDreamLog(fixture('missed-gap.txt')).runs;
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, Date.parse('2026-09-06T03:00:00'));
  assert.equal(nights.find((n) => n.date === '2026-09-06'), undefined);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './dreamSchedule'`.

- [ ] **Step 4: Write the implementation**

Create `server/dreamSchedule.ts`:

```typescript
/** Expected-night derivation. The clock is injected; there is no I/O here —
 *  the caller reads the plist and passes its text in.
 *
 *  The governing rule is in the spec (§7): never invent an alarm. A missed
 *  night is a claim, and a claim needs a schedule to be measured against. When
 *  the schedule is unknown we emit no missed nights at all rather than falling
 *  back to a hardcoded hour — that hour has moved repeatedly, and a detector
 *  keyed to a stale one manufactures false alarms, which is the exact failure
 *  this feature exists to prevent. */

import type { DreamRunRecord } from './dreamParse';
import type { DreamNightStatus } from './db';

export interface DreamSchedule {
  hour: number;
  minute: number;
}

export interface NightSlot {
  date: string;
  expectedAt: number;
}

export interface DerivedNight extends NightSlot {
  runIndex: number | null;
  status: DreamNightStatus;
}

const DAY_MS = 86_400_000;

/** `StartCalendarInterval` → hour/minute. Returns null when either key is
 *  absent or unparseable; callers must treat null as "unknown", not "default". */
export function parseSchedule(plistXml: string): DreamSchedule | null {
  const block = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plistXml);
  if (!block) return null;
  const read = (key: string): number | null => {
    const m = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(block[1]);
    return m ? Number(m[1]) : null;
  };
  const hour = read('Hour');
  const minute = read('Minute');
  if (hour === null || minute === null) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function expectedNights(
  schedule: DreamSchedule,
  from: number,
  to: number
): NightSlot[] {
  const out: NightSlot[] = [];
  const cursor = new Date(from);
  cursor.setHours(schedule.hour, schedule.minute, 0, 0);
  /* Starting before `from` would emit a slot the caller did not ask for. */
  if (cursor.getTime() < from) cursor.setTime(cursor.getTime() + DAY_MS);

  for (let t = cursor.getTime(); t <= to; t += DAY_MS) {
    out.push({ date: localDate(t), expectedAt: t });
  }
  return out;
}

const STATUS: Record<string, DreamNightStatus> = {
  completed: 'ok',
  warned: 'warned',
  truncated: 'truncated',
  running: 'unknown',
};

export function deriveNights(
  runs: DreamRunRecord[],
  schedule: DreamSchedule | null,
  now: number
): DerivedNight[] {
  const byDate = new Map<string, { run: DreamRunRecord; index: number }>();
  runs.forEach((run, index) => {
    const date = localDate(run.startedAt);
    if (!byDate.has(date)) byDate.set(date, { run, index });
  });

  /* No schedule: report only nights we have evidence for. */
  if (!schedule) {
    return [...byDate.entries()]
      .map(([date, { run, index }]) => ({
        date,
        expectedAt: run.startedAt,
        runIndex: index,
        status: STATUS[run.termination] ?? 'unknown',
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  if (runs.length === 0) return [];

  const first = Math.min(...runs.map((r) => r.startedAt));
  const slots = expectedNights(schedule, first - DAY_MS, now);

  return slots.map((slot) => {
    const hit = byDate.get(slot.date);
    if (hit) {
      return {
        ...slot,
        runIndex: hit.index,
        status: STATUS[hit.run.termination] ?? 'unknown',
      };
    }
    return { ...slot, runIndex: null, status: 'missed' as DreamNightStatus };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS. The `NO SCHEDULE MEANS NO MISSED CLAIMS` test is the important one.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add server/dreamSchedule.ts server/dreamSchedule.test.ts server/fixtures/dream/missed-gap.txt
git commit -m "feat: derive expected nights and detect missed ones

Reads the LaunchAgent schedule rather than assuming 07:05, because that
hour has moved repeatedly. When the schedule cannot be read the detector
emits no missed nights at all: a stale hardcoded hour would manufacture
false alarms, which is worse than reporting nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Ingest orchestration

The only module that touches the filesystem or shells a subprocess.

**Files:**
- Create: `server/dreamIngest.ts`
- Create: `server/dreamIngest.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `Store` from `./db`.
- Produces: `createDreamIngest(opts: DreamIngestOptions): DreamIngest` where `DreamIngest` is `{ run(now?: number): DreamIngestResult; }` and `DreamIngestResult` is `{ ok: boolean; error: string | null; runsIngested: number; unrecognisedCount: number; scheduleKnown: boolean; }`.

- [ ] **Step 1: Write the failing test**

Create `server/dreamIngest.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './db';
import { createDreamIngest } from './dreamIngest';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dream-ingest-'));
}

const PLIST = `<plist><dict><key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict>
</dict></plist>`;

const RUN = [
  '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
  '[dream-nightly] cycling sources: default',
  'Dream cycle (partial) in 1.4s:',
  '  ✓ lint  0 fix(es) applied; 335 non-fixable',
  '[dream-nightly] stamped last_full_cycle_at for default',
  '[dream-nightly] Sat Sep  5 08:00:00 EDT 2026 done (dream exit=0)',
  '',
].join('\n');

function harness(logText: string) {
  const dir = tmp();
  const logPath = path.join(dir, 'dream.log');
  const plistPath = path.join(dir, 'agent.plist');
  fs.writeFileSync(logPath, logText);
  fs.writeFileSync(plistPath, PLIST);
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: true,
    retentionDays: 90,
    transcriptRetentionDays: 7,
  });
  const ingest = createDreamIngest({ store, logPath, plistPath, brainDir: null });
  return { dir, logPath, store, ingest };
}

test('ingests a run and records the night', () => {
  const { store, ingest } = harness(RUN);
  const res = ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(res.ok, true);
  assert.equal(res.runsIngested, 1);
  assert.equal(store.queryDreamNights(10)[0].date, '2026-09-05');
  store.close();
});

test('a missing log is reported, not thrown', () => {
  const { store, ingest, logPath } = harness(RUN);
  fs.rmSync(logPath);
  const res = ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /ENOENT|no such file/i);
  store.close();
});

test('no brain dir means commit_source is unavailable, not none', () => {
  const { store, ingest } = harness(RUN);
  ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(store.getDreamNight('2026-09-05')?.run?.commitSource, 'unavailable');
  store.close();
});

test('is incremental: a second run with no new bytes ingests nothing', () => {
  const { store, ingest } = harness(RUN);
  ingest.run(Date.parse('2026-09-05T12:00:00'));
  const second = ingest.run(Date.parse('2026-09-05T12:01:00'));
  assert.equal(second.runsIngested, 0);
  store.close();
});

test('re-evaluates a run that was incomplete on the previous pass', () => {
  const incomplete = RUN.split('\n').slice(0, 5).join('\n') + '\n';
  const { store, ingest, logPath } = harness(incomplete);

  ingest.run(Date.parse('2026-09-05T07:30:00'));
  assert.equal(store.getDreamNight('2026-09-05')?.run?.termination, 'truncated');

  fs.writeFileSync(logPath, RUN); // the run finishes
  const res = ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(res.runsIngested, 1, 'must rewind, not skip');
  assert.equal(store.getDreamNight('2026-09-05')?.run?.termination, 'completed');
  store.close();
});

test('offsets are byte offsets — multibyte marks do not desync ingest', () => {
  const { store, ingest, logPath } = harness(RUN);
  ingest.run(Date.parse('2026-09-05T12:00:00'));
  fs.appendFileSync(
    logPath,
    ['[dream-nightly] Sun Sep  6 07:05:06 EDT 2026 starting',
     'Dream cycle (partial) in 1.0s:',
     '  ✓ lint  ✓✓✓ — multibyte — 0 fix(es)',
     '[dream-nightly] Sun Sep  6 08:00:00 EDT 2026 done (dream exit=0)', ''].join('\n')
  );
  const res = ingest.run(Date.parse('2026-09-06T12:00:00'));
  assert.equal(res.runsIngested, 1);
  assert.equal(store.getDreamNight('2026-09-06')?.run?.termination, 'completed');
  store.close();
});

test('an unreadable plist disables missed-night claims but still ingests', () => {
  const { store, ingest, dir } = harness(RUN);
  fs.writeFileSync(path.join(dir, 'agent.plist'), 'garbage');
  const res = ingest.run(Date.parse('2026-09-08T12:00:00'));
  assert.equal(res.ok, true);
  assert.equal(res.scheduleKnown, false);
  assert.equal(store.queryDreamNights(20).some((n) => n.status === 'missed'), false);
  store.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './dreamIngest'`.

- [ ] **Step 3: Write the implementation**

Create `server/dreamIngest.ts`:

```typescript
/** The only dream module that touches the outside world: reads the log file,
 *  shells `git log` in the brain repo, and writes through the store.
 *
 *  Everything it calls is pure, so the interesting logic is testable without a
 *  filesystem and this file stays thin enough to read in one sitting. */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseDreamLog, parseDreamCommits } from './dreamParse';
import { attributeRun } from './dreamAttribute';
import { parseSchedule, deriveNights } from './dreamSchedule';
import type { Store, DreamCommitSource } from './db';

export interface DreamIngestOptions {
  store: Store;
  logPath: string;
  plistPath: string;
  /** Brain repo for the commit cross-check. null disables it — which yields
   *  `unavailable`, never `none`. */
  brainDir: string | null;
}

export interface DreamIngestResult {
  ok: boolean;
  error: string | null;
  runsIngested: number;
  unrecognisedCount: number;
  scheduleKnown: boolean;
}

export interface DreamIngest {
  run(now?: number): DreamIngestResult;
}

function readCommits(brainDir: string | null): Map<string, string> | null {
  if (!brainDir) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', brainDir, 'log', '--format=%h %ad %s', '--date=short', '-n', '400'],
      { encoding: 'utf8', timeout: 10_000 }
    );
    return parseDreamCommits(out);
  } catch {
    /* A missing repo, a missing git, or a timeout are all "could not check".
       Returning null keeps that distinct from "checked and found nothing". */
    return null;
  }
}

function readSchedule(plistPath: string) {
  try {
    return parseSchedule(fs.readFileSync(plistPath, 'utf8'));
  } catch {
    return null;
  }
}

class Ingest implements DreamIngest {
  constructor(private readonly o: DreamIngestOptions) {}

  run(now: number = Date.now()): DreamIngestResult {
    const { store, logPath } = this.o;
    let text: string;
    let baseOffset = store.dreamIngestOffset();

    try {
      const fd = fs.openSync(logPath, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        /* A shrunken file means it was rotated or truncated; the stored offset
           is meaningless, so start over rather than reading from the middle. */
        if (baseOffset > size) baseOffset = 0;
        const length = size - baseOffset;
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, baseOffset);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        runsIngested: 0,
        unrecognisedCount: 0,
        scheduleKnown: false,
      };
    }

    const parsed = parseDreamLog(text);
    const commits = readCommits(this.o.brainDir);
    const schedule = readSchedule(this.o.plistPath);

    for (const run of parsed.runs) attributeRun(run);

    const runIds: (number | null)[] = parsed.runs.map((run) => {
      const date = new Date(run.startedAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
      ).padStart(2, '0')}`;
      const fromLog = run.committedShas.size > 0;
      const fromGit = commits?.get(key) ?? null;

      let source: DreamCommitSource;
      if (commits === null) source = 'unavailable';
      else if (fromLog && fromGit) source = 'both';
      else if (fromLog) source = 'log';
      else if (fromGit) source = 'git';
      else source = 'none';

      return store.insertDreamRun(run, fromGit, source);
    });

    for (const night of deriveNights(parsed.runs, schedule, now)) {
      const id = night.runIndex === null ? null : runIds[night.runIndex] ?? null;
      store.upsertDreamNight(night.date, night.expectedAt, id, night.status);
    }

    /* Rewind to the last unterminated run so it is re-read next pass; a run
       that was `running` when we parsed it would otherwise be frozen in that
       state forever. */
    const consumed =
      parsed.lastIncompleteRunOffset !== null
        ? baseOffset + parsed.lastIncompleteRunOffset
        : baseOffset + Buffer.byteLength(text, 'utf8');
    store.setDreamIngestOffset(consumed);

    return {
      ok: true,
      error: null,
      runsIngested: parsed.runs.length,
      unrecognisedCount: parsed.unrecognisedCount,
      scheduleKnown: schedule !== null,
    };
  }
}

export function createDreamIngest(o: DreamIngestOptions): DreamIngest {
  return new Ingest(o);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | tail -25`
Expected: PASS. The rewind test and the byte-offset test are the two that catch the subtle bugs.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add server/dreamIngest.ts server/dreamIngest.test.ts
git commit -m "feat: dream log ingest with incremental byte offsets

Reads the log from a stored byte offset (not character offset — the log is
full of multibyte marks), rewinding to the last unterminated run so a run
that was still going last pass is re-evaluated instead of frozen.

A failed or disabled git cross-check records commit_source 'unavailable',
never 'none', so 'could not check' cannot render as 'did not commit'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Ingest wiring and config

Config resolution and a cached accessor, kept out of `server.ts` so Task 7's edit stays a few lines.

**Files:**
- Create: `server/dreamService.ts`
- Create: `server/dreamService.test.ts`

**Interfaces:**
- Consumes: `createDreamIngest` from `./dreamIngest`, `Store` from `./db`.
- Produces: `createDreamService(store: Store, env?: NodeJS.ProcessEnv): DreamService` where `DreamService` is `{ nights(limit: number): DreamNightsPayload; night(date: string): DreamNightDetail | null; }` and `DreamNightsPayload` is `{ nights: DreamNightRow[]; status: { ok: boolean; error: string | null; scheduleKnown: boolean; unrecognisedCount: number } }`.

- [ ] **Step 1: Write the failing test**

Create `server/dreamService.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './db';
import { createDreamService } from './dreamService';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-svc-'));
  fs.writeFileSync(
    path.join(dir, 'dream.log'),
    ['[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
     '[dream-nightly] Sat Sep  5 08:00:00 EDT 2026 done (dream exit=0)', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'agent.plist'),
    `<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict></dict></plist>`
  );
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: true,
    retentionDays: 90,
    transcriptRetentionDays: 7,
  });
  const env = {
    GBRAIN_LOG_PATH: path.join(dir, 'dream.log'),
    GBRAIN_DREAM_PLIST: path.join(dir, 'agent.plist'),
  } as NodeJS.ProcessEnv;
  return { store, env, dir };
}

test('serves nights and reports ingest status', () => {
  const { store, env } = harness();
  const svc = createDreamService(store, env);
  const payload = svc.nights(14);
  assert.equal(payload.status.ok, true);
  assert.ok(payload.nights.length >= 1);
  store.close();
});

test('a broken log degrades to an error payload, never throws', () => {
  const { store, env } = harness();
  const svc = createDreamService(store, { ...env, GBRAIN_LOG_PATH: '/nonexistent/x.log' });
  const payload = svc.nights(14);
  assert.equal(payload.status.ok, false);
  assert.ok(payload.status.error);
  assert.deepEqual(payload.nights, []);
  store.close();
});

test('night detail returns null for an unknown date', () => {
  const { store, env } = harness();
  assert.equal(createDreamService(store, env).night('1999-01-01'), null);
  store.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './dreamService'`.

- [ ] **Step 3: Write the implementation**

Create `server/dreamService.ts`:

```typescript
/** Config resolution plus a 30-second ingest cache. Exists so server.ts gains
 *  two thin routes rather than this bookkeeping. */

import os from 'node:os';
import path from 'node:path';
import { createDreamIngest, type DreamIngestResult } from './dreamIngest';
import type { Store, DreamNightRow, DreamNightDetail } from './db';

const CACHE_MS = 30_000;

export interface DreamNightsPayload {
  nights: DreamNightRow[];
  status: {
    ok: boolean;
    error: string | null;
    scheduleKnown: boolean;
    unrecognisedCount: number;
  };
}

export interface DreamService {
  nights(limit: number): DreamNightsPayload;
  night(date: string): DreamNightDetail | null;
}

export function createDreamService(store: Store, env: NodeJS.ProcessEnv = process.env): DreamService {
  const home = os.homedir();
  const ingest = createDreamIngest({
    store,
    logPath: env.GBRAIN_LOG_PATH ?? path.join(home, '.gbrain', 'dream-nightly.log'),
    plistPath:
      env.GBRAIN_DREAM_PLIST ??
      path.join(home, 'Library', 'LaunchAgents', 'com.gbrain.dream-nightly.plist'),
    brainDir: env.GBRAIN_BRAIN_DIR ?? path.join(home, 'mybrain'),
  });

  let last: DreamIngestResult | null = null;
  let lastAt = 0;

  const refresh = (): DreamIngestResult => {
    const now = Date.now();
    if (last && now - lastAt < CACHE_MS) return last;
    last = ingest.run(now);
    lastAt = now;
    return last;
  };

  return {
    nights(limit: number): DreamNightsPayload {
      const res = refresh();
      return {
        nights: res.ok ? store.queryDreamNights(limit) : [],
        status: {
          ok: res.ok,
          error: res.error,
          scheduleKnown: res.scheduleKnown,
          unrecognisedCount: res.unrecognisedCount,
        },
      };
    },
    night(date: string): DreamNightDetail | null {
      refresh();
      return store.getDreamNight(date);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add server/dreamService.ts server/dreamService.test.ts
git commit -m "feat: dream service with config resolution and 30s cache

Keeps path resolution and cache bookkeeping out of server.ts so the route
wiring stays two handlers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: API routes

**This is the only task that touches `server/server.ts`**, which Tasks 7–9 of the rapid-mlx plan rewrite. Hold or rebase this task per spec §11; Tasks 1–6 and 8 are unaffected either way.

**Files:**
- Modify: `server/server.ts` (add two routes beside the existing `/api/history/*` handlers)

**Interfaces:**
- Consumes: `createDreamService` from `./dreamService`, the existing `store` singleton in `server.ts`.
- Produces: `GET /api/dream/nights?limit=N` → `DreamNightsPayload`; `GET /api/dream/nights/:date` → `DreamNightDetail` or 404.

- [ ] **Step 1: Add the routes**

In `server/server.ts`, after the existing `app.get('/api/history/runs/:id', …)` handler:

```typescript
import { createDreamService } from './dreamService';

const dream = createDreamService(store);

app.get('/api/dream/nights', (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 365) : 14;
  res.json(dream.nights(limit));
});

app.get('/api/dream/nights/:date', (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const detail = dream.night(req.params.date);
  if (!detail) {
    res.status(404).json({ error: 'no such night' });
    return;
  }
  res.json(detail);
});
```

- [ ] **Step 2: Typecheck and verify against the real log**

```bash
npm run typecheck
npm run dev &
sleep 3
curl -s 'http://127.0.0.1:8123/api/dream/nights?limit=5' | head -c 800; echo
curl -s 'http://127.0.0.1:8123/api/dream/nights/2026-09-05' | head -c 800; echo
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8123/api/dream/nights/nonsense'
kill %1
```

Expected: the first returns nights including `2026-09-05`; the second returns that night with `termination: "warned"`, `globalPassRc: 143`, and a non-null `committedSha`; the third returns `400`.

If `status.ok` is false, read `status.error` — the most likely causes are a different log path or a `~/mybrain` that is not a git repo.

- [ ] **Step 3: Commit**

```bash
git add server/server.ts
git commit -m "feat: serve dream nights over two read-only routes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The triage page

**Files:**
- Create: `public/dream.html`
- Modify: `public/index.html`, `public/log.html`, `public/history.html` (one nav link each)

**Interfaces:**
- Consumes: `GET /api/dream/nights`, `GET /api/dream/nights/:date`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the page**

Create `public/dream.html`. Framework-free, everything inline, matching the other four pages. Copy the `<style>` conventions from `public/history.html` so the palette matches — this file supplies structure, not a new theme.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dream health</title>
<style>
  /* Match history.html's palette. Only dream-specific rules live here. */
  .nights { display: flex; gap: 4px; flex-wrap: wrap; margin: 12px 0; }
  .night { width: 58px; padding: 6px 2px; text-align: center; font-size: 10px;
           border: 1px solid #444; border-radius: 3px; cursor: pointer; }
  .night b { display: block; font-size: 11px; }
  .night.sel { outline: 2px solid currentColor; }
  .st-ok      { background: rgba(46,160,67,.20);  border-color: rgba(46,160,67,.75); }
  .st-warned  { background: rgba(210,153,34,.22); border-color: rgba(210,153,34,.80); }
  .st-truncated { background: rgba(218,54,51,.20); border-color: rgba(218,54,51,.80); }
  .st-missed  { background: rgba(128,128,128,.14); border-style: dashed; }
  .st-unknown { background: rgba(128,128,128,.10); }
  .srow { padding: 4px 0; border-bottom: 1px solid #333; font-size: 12px; }
  .mark-ran { color: #3fb950; } .mark-noop { color: #d29922; } .mark-skipped { opacity: .55; }
  .fail { color: #f85149; font-size: 11px; margin-left: 18px; }
  .banner { padding: 8px 10px; border: 1px solid #d29922; border-radius: 3px;
            margin: 8px 0; font-size: 12px; }
  .muted { opacity: .65; }
</style>
</head>
<body>
<nav>
  <a href="index.html">Dashboard</a>
  <a href="log.html">Live log</a>
  <a href="history.html">History</a>
  <a href="dream.html" class="active">Dream</a>
</nav>

<h1>Dream health</h1>
<div id="status"></div>
<div class="nights" id="strip"></div>
<div id="detail"></div>

<script>
const $ = (id) => document.getElementById(id);
const fmt = (ms) => ms ? new Date(ms).toLocaleString() : '—';

async function load() {
  let payload;
  try {
    payload = await (await fetch('/api/dream/nights?limit=14')).json();
  } catch (e) {
    $('status').innerHTML = '<div class="banner">Could not reach the server: ' + e.message + '</div>';
    return;
  }

  const warnings = [];
  if (!payload.status.ok) warnings.push('Log unreadable: ' + payload.status.error);
  // Absence of a schedule disables missed-night detection; say so rather than
  // letting the strip imply every night ran.
  if (!payload.status.scheduleKnown) warnings.push('Schedule unknown — missed nights are NOT detected.');
  if (payload.status.unrecognisedCount > 0)
    warnings.push(payload.status.unrecognisedCount + ' unrecognised log line(s) — the parser may be out of date.');
  $('status').innerHTML = warnings.map((w) => '<div class="banner">' + w + '</div>').join('');

  const strip = $('strip');
  strip.innerHTML = '';
  for (const n of [...payload.nights].reverse()) {
    const el = document.createElement('div');
    el.className = 'night st-' + n.status;
    el.innerHTML = '<b>' + n.date.slice(5) + '</b>' + n.status;
    el.onclick = () => { select(el); detail(n.date); };
    strip.appendChild(el);
  }
  const last = strip.lastElementChild;
  if (last) { select(last); detail(payload.nights[0].date); }
}

function select(el) {
  for (const n of document.querySelectorAll('.night')) n.classList.remove('sel');
  el.classList.add('sel');
}

async function detail(date) {
  const res = await fetch('/api/dream/nights/' + date);
  if (!res.ok) { $('detail').innerHTML = '<p class="muted">No run for ' + date + '.</p>'; return; }
  const d = await res.json();
  if (!d.run) { $('detail').innerHTML = '<p class="muted">' + date + ': never fired.</p>'; return; }

  const r = d.run;
  let head = '<h2>' + date + '</h2><p>' + fmt(r.startedAt) + ' → ' + fmt(r.endedAt) +
             ' · <b>' + r.termination + '</b>';
  if (r.globalPassRc !== null) head += ' · global pass rc=' + r.globalPassRc;
  head += '</p>';

  /* The parsed reading and the git cross-check can disagree — a run can commit
     without ever printing `done`. Show the disagreement; do not resolve it. */
  if (r.commitSource === 'unavailable')
    head += '<p class="muted">Commit status could not be checked.</p>';
  else if (r.commitSource === 'none')
    head += '<p class="muted">No commit for this night.</p>';
  else head += '<p>Committed <code>' + r.committedSha + '</code> <span class="muted">(' + r.commitSource + ')</span>';
  if (r.termination !== 'completed' && r.committedSha)
    head += ' <b>— banked work despite not finishing.</b>';
  head += '</p>';

  const bySource = new Map();
  for (const p of d.phases) {
    const key = p.sourceId || '(unattributed)';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(p);
  }

  let body = '';
  for (const [source, phases] of bySource) {
    body += '<div class="srow"><b>' + source + '</b> ';
    body += phases.map((p) =>
      '<span class="mark-' + p.mark + '" title="' + p.phase + ': ' + p.text.replace(/"/g, '&quot;') + '">' +
      (p.mark === 'ran' ? '✓' : p.mark === 'noop' ? '!' : '−') + '</span>').join(' ');
    body += '</div>';
    for (const p of phases) {
      for (const f of JSON.parse(p.failuresJson || '[]'))
        body += '<div class="fail">✗ ' + f.slug + ': ' + f.message + '</div>';
    }
  }

  $('detail').innerHTML = head + body;
}

load();
</script>
</body>
</html>
```

- [ ] **Step 2: Add the nav link to the other pages**

The existing nav markup, verified at the branch tip, is three anchors with `class="active"` marking the current page:

```html
<a href="index.html" class="active">Dashboard</a>
<a href="log.html">Live log</a>
<a href="history.html">History</a>
```

Confirm the insertion point, then add one line after the History anchor in each of the three files:

```bash
grep -n 'href="history.html"' public/index.html public/log.html public/history.html
```

```html
<a href="dream.html">Dream</a>
```

Change nothing else in these files. They carry uncommitted modifications in the sibling `rapid-mlx-prometheus` worktree, so a one-line diff keeps the eventual conflict to one line.

- [ ] **Step 3: Verify in a browser**

```bash
npm run dev &
sleep 3
open http://127.0.0.1:8123/dream.html
```

Check by eye:
1. The strip shows 14 cells; Sep 3 and Sep 4 render dashed as `missed`.
2. Sep 5 is selected by default and reads `warned`, rc=143, with the commit line and the "banked work despite not finishing" note.
3. `default` shows a `!` for `extract_atoms` with the `career-ops/by-company/n8n` failure beneath it.
4. No unattributed group appears for Sep 5 — if one does, Task 2's rule regressed.

Then `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add public/dream.html public/index.html public/log.html public/history.html
git commit -m "feat: dream health triage page

Night strip leads so a night that never fired renders as a cell rather
than an absence. Where the parsed reading and the git cross-check
disagree — committed but never printed done — the page states both
instead of resolving it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2.1 line grammar | 1 |
| §2.2 attribution trap | 2 |
| §2.3 two unterminated shapes | 1 (`termination`), 3 (stored), 8 (shown) |
| §2.4 git + plist signals | 1 (`parseDreamCommits`), 4 (`parseSchedule`), 5 (shelling) |
| §3 four failure modes | 1+2 (phase), 3 (storage), 4 (missed), 8 (view) |
| §4 data model, §4.1 uncertainty, §4.2 SQL safety | 3 |
| §5 components, incrementality, config | 1–6 |
| §6 layout B, disagreement displayed | 8 |
| §7 error handling | 4 (no schedule), 5 (log/git), 6 (degraded payload), 8 (banners) |
| §8 fixtures and tests | every task |
| §9 out of scope | nothing implements SSE, alerting, writes, or `.err` parsing |
| §10 deferred | `attribution` + `commit_source` are the seams; nothing else added |
| §11 sequencing | Task 7 isolates the `server.ts` collision |

**Placeholder scan:** none. Every step carries runnable commands or complete code.

**Type consistency:** `DreamMark` values `ran|skipped|noop` are used identically in Tasks 1, 2, 3 and 8. `DreamAttribution` is declared in `dreamParse.ts` and consumed in `dreamAttribute.ts`. `DreamCommitSource` is declared in `db.ts` (Task 3) and imported by `dreamIngest.ts` (Task 5). `precedingStampIndex` is set in Task 1 and read in Task 2. `DreamNightRow`/`DreamNightDetail` are declared in Task 3 and consumed in Tasks 6, 7, 8.

**One known circularity to watch:** `dreamSchedule.ts` imports `DreamNightStatus` from `./db`, and `db.ts` imports `DreamRunRecord` from `./dreamParse`. Both are `import type` and erased at compile time, so no runtime cycle exists. Keep them `import type`.
