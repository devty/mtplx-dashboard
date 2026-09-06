# Dream-health triage for the dashboard

Date: 2026-09-05
Status: implemented. Amended 2026-09-05 after the whole-branch review, so this document
describes what actually shipped — §4 (numerics, `scope`, schema version), §5
(incrementality's window contract) and §6/§10 (Trends) were corrected rather than left
promising things the code does not do. This is binding authority; a wrong spec is worse
than no spec.
Branch: `dream-health-triage` (cut from `rapid-mlx-prometheus`)

## 1. Context

gbrain runs a nightly "dream" — a one-shot maintenance cycle driven by a `gui/501`
LaunchAgent. It walks every source through ~20 phases, then runs a brain-wide global
pass, then commits the brain repo. When it works, it is invisible. When it does not,
the only evidence is `~/.gbrain/dream-nightly.log`: a single append-only text file,
~192KB and growing, holding every night concatenated.

Reviewing a night therefore means grepping for run boundaries, scoping to the last
`starting`…`done` block by hand, counting phase marks by eye, and inferring absence
from lines that are not there. On 2026-09-05 that manual review took a dozen commands
and still needed `launchctl print`, `last | grep console` and the brain's `git log` to
reach a conclusion.

None of this data is queryable. There is no `cycle_runs` table in gbrain — the
migrations carry `gbrain_cycle_locks` and `dream_verdicts`, but per-phase outcomes exist
only as printed text. This design makes that history queryable and puts a triage view in
front of it.

### 1.1 Why here and not in gbrain

gbrain is a fork that is regularly rebased onto upstream. Adding a cycle-run table and
write path there would mean fork-only schema in a repo whose migration numbering must
track upstream exactly (fork-only schema belongs in `fork-schema-realign.ts`, never in
`MIGRATIONS`), and it would yield zero history until it had run for weeks.

Parsing the log from this dashboard costs upstream nothing and backfills roughly two
months of history on first ingest. The trade accepted in exchange is brittleness: we are
parsing human-readable output, and format drift is a real risk. Section 8 makes that
drift a failing test rather than a silently empty page.

## 2. What the log actually exposes

Verified against the live log on 2026-09-05.

### 2.1 Line grammar

Run-level, all prefixed `[dream-nightly]`:

- `<Day Mon DD HH:MM:SS TZ YYYY> starting` — run boundary, carries a full timestamp.
- `<Day Mon DD HH:MM:SS TZ YYYY> done (dream exit=N)` — clean terminator.
- `WARN: global pass failed (rc=N)` — the global pass failed. Three occurrences in the
  entire log: `rc=1` (a real error) and `rc=143` twice (SIGTERM). `rc` distinguishes a
  crash from a kill.
- `cycling sources: <space-separated source ids>` — the ordered source list for the run.
- `stamped last_full_cycle_at for <source>` — a source finished a phase group.
- `global pass (brain-wide phases, once)` — the global pass begins.

Commit-level, prefixed `[dream-nightly:commit]`:

- `<source> committed <sha>` / `<source> pushed to origin` / `<source> re-synced (freshness advanced)`

Cycle blocks, unprefixed:

- `Dream cycle (<reason>) in <N>s:` opens a block. **Two reasons occur:** `partial`
  (63 occurrences) and `ok` (29) — matching only `partial` drops a third of all blocks.
  Worse, a dropped opener leaves the previous block open, so the next source's phase
  lines append to it. Match any reason word.
- `  <mark> <phase>  <text>` where mark is `✓` (ran), `-` (skipped: cooldown or disabled),
  `!` (ran but applied nothing), or `✗` (the phase failed outright and wrote nothing).
  Five `✗` phase marks occur in the log: two `patterns`, three `calibration_profile`.
- `      [<Class>/<CODE>] <detail>` — the classification line beneath a failed phase, e.g.
  `[InternalError/PATTERNS_CHILD_DEAD]`. One per failed phase in the log so far.
- `      ✗ <slug>: <message>` — a nested per-item failure under a phase line.

**`✗` means two different things at two indents, and only the indent tells them apart.**
At exactly two spaces it is the phase's own verdict; at six it is one item failing inside a
phase that otherwise ran. A parser that models only the nested form silently drops the more
important one, and the night renders clean.
- `  totals: lint=N backlinks=N synced=N …` — closes some blocks.

Noise interleaved between blocks: `Brain is healthy. N phase(s) checked in N.Ns.`,
`No stale pages — extraction is up to date.`, and the `[dream-nightly:patch]`,
`[dream-nightly:export]`, `[dream-nightly:mtplx]`, `[dream-nightly:parity]` prefixes.

**Only run-boundary lines carry timestamps.** Phase lines do not. Everything else is
positional, which is what makes Section 2.2 dangerous.

### 2.2 The source-attribution trap

The intuitive rule — a `Dream cycle` block belongs to the next
`stamped last_full_cycle_at for X` — is **wrong**. Observed on 2026-09-05:

```
Dream cycle (partial) in 1.4s:          ← lint 1735 non-fixable, backlinks 578
[dream-nightly] stamped … for default
Dream cycle (partial) in 812.4s:        ← extract_atoms, consolidate, propose_takes
[dream-nightly] stamped … for calendar
```

The 812-second block is `default`'s second (heavy) phase group, emitted *after* its own
stamp. Three independent signals confirm it: `conversation_facts_backfill 0 facts
inserted across 10/10 sources` is brain-wide, `consolidate … across 596 buckets` and
`propose_takes: scanned 100 pages` are far too large for `calendar`, and the failing item
was `career-ops/by-company/n8n`, which lives under `default`.

Applying the intuitive rule would file the busiest source's heaviest work under a trivial
source — silently, and in the direction most likely to be acted on. A source can emit a
block after its own stamp, so stamps are not reliable terminators.

**Consequence:** attribution is a separate, fallible concern from parsing, it records how
it reached its answer, and it is allowed to answer "unknown".

### 2.3 Two distinct unterminated shapes

| Shape | Evidence in log | Observed |
|---|---|---|
| `warned` — trap ran | `WARN: global pass failed (rc=N)`, commit lines, no `done` | Sep 5 (rc=143), Aug 18 10:54 (rc=143) |
| `truncated` — hard kill | last source line, then nothing: no WARN, no commit, no `done` | Sep 1, Sep 2 |

These have different causes and different remedies, so they are different states, not one
"failed" bucket. Sep 1 and Sep 2 died without their trap running at all.

### 2.4 Signals outside the log

- **The brain repo** (`~/mybrain`) carries `dream: auto-commit gbrain writes <date>`
  commits. This is authoritative for "did this night bank work" and is independent of
  anything parsed. It matters: on Sep 5 the run committed `e7fd46f` and pushed it while
  never printing a `done` line. A log-only reading scores that night as a failure.
- **The LaunchAgent plist** (`~/Library/LaunchAgents/com.gbrain.dream-nightly.plist`)
  carries `StartCalendarInterval` `Hour`/`Minute` — currently 07:05. This hour has moved
  repeatedly; it is read, never assumed.

## 3. Scope

Four failure modes, all required:

1. **Run started, never finished** — needs an explicit unterminated state (§2.3).
2. **Night silently missed** — absence of evidence; needs a schedule model (§2.4).
3. **Phase-level failures** — `✗` phase marks, `!` marks, and nested `✗` items; needs
   per-phase records. A `✗` phase is the loudest of the three: a run can exit 0 with one
   inside it, so the night's own status will not carry the signal.
4. **Chronic backlog / drift** — lint remaining, calibration stall, orphan ratio; needs
   history depth.

## 4. Data model

Four dream tables added to the existing `data/history.db` alongside `run` / `request` /
`transcript` / `gauge`, plus a single-row `dream_ingest` table holding the byte offset §5
requires. `SCHEMA_VERSION` goes 2 → 5 (3 added the tables; 4 added the `scope` column below; 5 added
`errors_json`);
the existing set-aside path handles the mismatch by moving the old file aside, so no migration
is written.

- **`dream_run`** — one row per `starting` line.
  `started_at`, `ended_at`, `exit_code`, `global_pass_rc`, `committed_sha`,
  `commit_source` ∈ `log` | `git` | `both` | `none` | `unavailable`, and
  `termination` ∈ `completed` | `warned` | `truncated` | `running`.
  `none` means the check ran and there is genuinely no commit; `unavailable` means the
  check could not run. §7 requires the view to distinguish these, so they cannot share a
  null.
  The enum encodes §2.3 rather than collapsing to a boolean, and is the seam where a
  second, structured signal can land later without a rewrite.

- **`dream_source_cycle`** — one row per `Dream cycle … in Ns:` block.
  `run_id`, `ordinal`, `duration_s`, `source_id` (nullable),
  `attribution` ∈ `stamped` | `inferred` | `unknown`, and `scope` ∈ `source` | `global`.
  `scope` exists because the brain-wide pass belongs to no source and is not *unattributed*
  either: it announces itself with its own marker line, and §6 renders it as its own row.
  Folding the largest block in the run into the bucket that means "we could not work this
  out" would dilute the one signal §4.1 exists to protect.

- **`dream_phase`** — one row per `✓ / ✗ / - / !` line.
  `run_id`, `cycle_id`, `source_id` (nullable), `phase`, `mark`, `scope`, `raw_text`, and
  nested `✗` items as `failure_count` (INTEGER) plus `failures_json` (TEXT,
  `[{slug, message}]`). These stay on the row rather than becoming a fifth table: they are
  small, bounded, and never read apart from their parent phase.
  A failed phase's own `[Class/CODE]` lines go in `errors_json` (TEXT, `[{code, detail}]`),
  NOT in `failures_json`: `{slug, message}` would present a whole-phase abort as one page
  failing inside a phase that ran, which is the misreading this view exists to prevent.
  **No parsed numerics.** An earlier draft of this section promised "parsed numerics where a
  known phase shape yields them"; no such columns were built and none are needed yet. Every
  number in the log is preserved verbatim in `raw_text`, which is what the view renders, and
  a per-phase numeric schema would have to be guessed shape-by-shape from human-readable
  output — exactly the brittleness §1.1 accepted only where it buys something. It is a
  seam for later, alongside §10, not a shipped feature.

- **`dream_night`** — one row per *expected* schedule slot, derived rather than parsed.
  `date`, `expected_at`, `run_id` (nullable), `status` ∈ `ok` | `warned` | `truncated` |
  `missed` | `unknown`. A missed night is a row, not an absence to notice.

### 4.1 Uncertainty is stored, not guessed

`source_id` is nullable on both `dream_source_cycle` and `dream_phase`, and every cycle
carries its `attribution` provenance. A block that cannot be confidently placed is stored
`unknown` and rendered as unattributed. Confidently-wrong attribution in an ops view is
worse than visibly-missing attribution, because it gets acted on.

### 4.2 SQL safety

Phase names and source ids come from parsed text. They are stored as **column values and
bound as parameters**, never interpolated into SQL. They must not be modelled on
`REQUEST_SERIES`, whose closed `Object.hasOwn` allowlist exists precisely because those
names *are* interpolated. This mirrors the rule already established for discovered gauge
series.

## 5. Components and data flow

Four server modules, following the module boundaries established by the rapid-mlx work
(`promParse` → `promSeries` → `db` → payload):

- **`server/dreamParse.ts`** — pure. Text in, records out. No I/O, no clock, no DB.
  Fixture-testable for the same reason `promParse.ts` is.
- **`server/dreamAttribute.ts`** — the §2.2 rules, isolated. Most likely component to be
  wrong and to need revision; separating it means changes cannot destabilise the parser.
  Emits `stamped` | `inferred` | `unknown`.
- **`server/dreamIngest.ts`** — the only module touching the outside world: reads the log,
  shells `git log` in the brain repo, writes through `createStore()`.
- **`server/dreamSchedule.ts`** — reads the plist, derives expected nights, marks missed.

**Trigger.** Fetch-on-load with a 30-second cache. No SSE, no poll loop — the dream is a
once-a-night batch and a live socket would be machinery serving nothing. This matches
`history.html`, which is already fetch-on-load and holds no SSE connection.

**Incrementality.** The log is append-only, so ingest stores a byte offset and parses
forward. The offset rewinds to the start of the last *incomplete* run rather than to
end-of-file, so a run that was `running` at parse time is re-evaluated instead of frozen
in that state. First ingest parses the whole file, backfilling existing history in one
pass.

**The rewind's consequence, and the rule it imposes.** Because of that rewind, every pass
after the first sees only a *tail* of the history. Anything that derives a window from the
runs in hand and then writes over that window will restate — and overwrite — nights it never
looked at, turning a correct `ok` into a fabricated `missed` on a re-ingest of unchanged
bytes. So: a pass may write authoritatively only within the window it actually parsed
(earliest parsed run's calendar day → now), and may make a `missed` claim outside that window
only where no row exists at all. The forward edge (the log ends on a completed run, so a later
pass parses nothing, yet "last night never ran" still needs saying) is handled by that
insert-only path, never by widening the authoritative window. This is a direct instance of §7:
a false `missed` is an invented alarm, and it lands on the exact night someone is reading.

**Configuration.** `GBRAIN_LOG_PATH`, `GBRAIN_BRAIN_DIR`, `GBRAIN_DREAM_PLIST`, each
defaulting to current locations, mirroring the existing `MTPLX_URL` convention.

## 6. The triage view

A fifth page, `public/dream.html`, framework-free and self-contained like the other four.

**Night strip leads.** A row of the last 14 nights (window configurable), one cell each, carrying date and
status. Missed nights render as real (dashed) cells — the layout requirement that drove
this choice, since two of the four must-catch modes are absences and a verdict banner can
only report what exists.

**Detail below, for the selected night.** Run header (start, end, `rc`, commit sha),
then one row per source showing its phase marks in order with a short summary, then the
global pass as its own row. Unattributed cycles appear in their own group rather than
being folded into a source.

**Disagreement is displayed, not resolved.** When the parsed reading and the git
cross-check disagree — no `done` line but a commit exists, as on Sep 5 — the view states
both. That disagreement is diagnostic and is the user's to interpret.

**Trends — NOT SHIPPED.** The original design gave trends (lint remaining, orphan ratio,
atom yield across the loaded window) a subordinate strip. No such strip was built, and §10's
deferral does not cover it: those three trends derive from stored `raw_text`, not from the
structured signals §10 defers. They are deferred here, explicitly and on their own terms —
each needs a per-phase numeric extraction that §4 deliberately does not have, and inventing
one to fill a strip would put guessed numbers on an ops screen. Revisit together with §4's
numerics seam.

## 7. Error handling

Governing rule: never invent an alarm, and never take the dashboard down. An ops screen
that has taught you to distrust it is worse than no screen.

- **Log missing/unreadable** → explicit "no log at `<path>`" state on the dream page only.
  Ingest never throws at server start; the other four pages are unaffected.
- **Schedule unreadable** → missed-night detection disables itself and says so. It does
  **not** fall back to a hardcoded 07:05; a detector keyed to a stale hour manufactures
  false missed nights. No schedule, no missed-night claims.
- **git or brain dir unavailable** → `committed_sha` null with `commit_source` null, and
  the view distinguishes *"no commit"* from *"couldn't check."* Collapsing these would
  render Sep-5-shaped nights as false failures.
- **Unrecognised line shapes** → stored with mark parsed and numerics null, and counted.
  The count is the drift canary and is surfaced in the UI.
- **Torn reads** (log appended while being read) → parse to the last complete line; the
  offset rewind covers the remainder on the next pass.
- **Schema mismatch** → existing set-aside path, per the pattern Task 3 established.

## 8. Testing

Fixture-driven, mirroring `promParse.test.ts` and `server/fixtures/`. Real log excerpts
committed under `server/fixtures/dream/`, one per shape:

| Fixture | Pins |
|---|---|
| `completed-run.txt` | `starting` → phases → commit → `done (dream exit=0)` |
| `warned-run.txt` | `WARN … (rc=143)`, commit present, no `done` |
| `truncated-run.txt` | Sep 1 shape: stops dead, no WARN, no commit |
| `missed-gap.txt` | Two runs spanning a skipped night |
| `attribution-trap.txt` | `default`'s 812s block sitting *after* its own stamp |

- `dreamParse.test.ts` — pure, fixture-driven.
- `dreamAttribute.test.ts` — asserts the 812s block resolves to `default`, not `calendar`,
  and that genuinely ambiguous blocks return `unknown` rather than a guess. This test is
  the reason the trap fixture exists.
- `dreamSchedule.test.ts` — injected clock and injected schedule; asserts a gap yields a
  `missed` row, and that an *unknown* schedule yields none.
- Store tests extend the existing `node:test` + throwaway on-disk SQLite pattern (not
  `:memory:`, which is private to the opening connection).
- **Coverage assertion:** parse the full committed log fixture and require zero
  unrecognised lines, so format drift fails the suite instead of silently emptying the
  page.

No frontend test harness. This repo does not have one and this design does not invent
one; page verification stays manual, as `CLAUDE.md` documents.

## 9. Out of scope

- **No SSE for dream data.** Once-a-night batch; fetch-on-load is sufficient.
- **No alerting or notifications.** The view is read when opened.
- **No write actions.** Read-only — no "re-run the dream" button, no lock clearing.
- **No changes to gbrain.** See §1.1.
- **No `.err` parsing.** It is progress heartbeats by design; its size carries no signal.

## 10. Deferred

The Trends strip (§6) and the per-phase numeric extraction it would need (§4). Both are
deferred for the same reason and land on the same seam: `raw_text` holds every number the log
prints, so nothing is lost, and neither is guessed.

The structured-signal enrichment (querying gbrain's Postgres for `last_full_cycle_at`
stamps, `dream_verdicts`, `gbrain_cycle_locks`, orphan and take counts) is deliberately
deferred. §4's `attribution` and `commit_source` fields are the seams it lands on. The
git cross-check ships in this phase because it is cheap, robust, and already proven
necessary by the Sep 5 disagreement.

## 11. Sequencing (resolved)

This design was written expecting Tasks 7–9 of
`2026-09-05-rapid-mlx-phase1-scrape-path.md` to rewrite `server/types.ts`, the poller and
the server payload wiring underneath it. Those tasks have since landed — `500a738` (the
Prometheus scraper replacing the MTPLX poller), `1b42785` (the `StatePayload` reshape and
server wiring) and `b018182` (the throughput/memory hero). This branch is cut from that
work, so the risk is retired rather than pending.

What survived the rewrite, verified against the branch tip:

- `SCHEMA_VERSION` is still 2, so §4's bump to 3 stands.
- `StoreOptions` and `createStore` are unchanged, so the store contract §4 relies on holds.
- `server.ts` still exposes the `store` singleton and the `/api/history/*` handlers that
  this feature's two routes sit beside.

One live overlap remains, outside this branch: `public/index.html`, `log.html` and
`history.html` have uncommitted modifications in the sibling `rapid-mlx-prometheus`
worktree. §6's nav-link edits touch the same three files.
