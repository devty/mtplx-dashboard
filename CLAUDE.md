# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A realtime dashboard for a local rapid-mlx inference server (LLM inference
on Apple Silicon, exposed as a standard Prometheus text-exposition `/metrics` endpoint). A small
Node/TypeScript server (`server/`) scrapes that endpoint itself on an interval and pushes updates
to connected browsers over Server-Sent Events. The five pages remain plain, framework-free
HTML/CSS/JS with everything inline:

- `public/index.html` — metrics dashboard (throughput + memory + queue-depth hero, latency,
  context, prefix cache, structured-output/tool-call health, spec-decode as a self-hiding card)
- `public/log.html` — per-request log. **Unavailable in this phase**: rapid-mlx exposes no
  per-request identity anywhere (not even mid-flight — `/v1/status.requests` stays empty while
  `num_running` is 1), so this page is a static explanatory panel, not a live feed. Returns with
  the Phase 2 capture proxy (see the design doc under `docs/superpowers/specs/`).
- `public/detail.html` — same unavailable state as `log.html`; was a permalink target for a log
  row, which no longer exists to link from.
- `public/history.html` — run history & comparison (per-run config diff, gauge charts discovered
  from the scrape)
- `public/dream.html` — gbrain nightly-dream health: a strip of recent nights (missed ones drawn
  as dashed cells, because two of the failure modes it catches are absences), then per-source
  phase marks, the global pass as its own row, and nested item failures. Fetch-on-load, no SSE —
  the dream is a once-a-night batch. Unlike the other pages it reads no rapid-mlx data at all;
  its source is `~/.gbrain/dream-nightly.log` plus a read-only `git log` cross-check.

`index.html` connects to `GET /api/events` SSE and renders off a shared `StatePayload` shape (see
`server/types.ts`). `log.html`/`detail.html` currently hold no SSE connection at all — there is
nothing for them to subscribe to. `history.html` is fetch-on-load only and holds no SSE connection
either (see Connection/offline handling below). There is still no shared JS *file* between any of
the five pages, so rendering/formatting logic (not data acquisition — see below) remains
hand-duplicated across them.

**This phase (Phase 1 — scrape path) is single-target and read-only**: no capture proxy, no
per-request data, one rapid-mlx backend. `server/targets.ts` and the `target_id` column already
exist so Phase 3 (multi-target) is additive rather than a schema change.

## Running / testing

```bash
npm install
npm run dev              # tsx watch server/server.ts — auto-restarts on change
# http://127.0.0.1:8123/              → dashboard
# http://127.0.0.1:8123/history.html  → run history & comparison
# http://127.0.0.1:8123/log.html      → explains why the live log is unavailable this phase
# http://127.0.0.1:8123/detail.html   → same, for the old permalink target

npm run build && npm start   # production: compile once, run plain node
npm run typecheck             # tsc --noEmit
```

`npm test` runs `node:test` unit tests: `promParse.test.ts` (Prometheus text parsing against
golden fixtures in `server/fixtures/`, including families that only appear after first traffic),
`promSeries.test.ts` (series-name derivation, counter deltas, restart detection),
`runTracker.test.ts` (run identity from `uptime_seconds`, including the derived-origin restart
case), `targets.test.ts` (`RAPID_MLX_TARGETS` parsing), `promScraper.test.ts` (per-interval
sparkline derivation, cumulative-vs-gauge classification), `db.test.ts` (the SQLite
persistence layer), and the dream suite — `dreamParse.test.ts`, `dreamAttribute.test.ts`,
`dreamSchedule.test.ts`, `dreamIngest.test.ts` and `dreamService.test.ts`, covering gbrain
nightly-dream log parsing, source attribution, missed-night derivation, ingest and caching
against fixtures in `server/fixtures/dream/` — all against a throwaway on-disk SQLite file in a
temp directory, not `:memory:`, because an in-memory database is private to the connection that
opened it and the tests assert through a second read connection. There is no frontend test
harness; verify page changes by loading them against a real rapid-mlx server. The server scrapes
a single configured target via `RAPID_MLX_TARGETS` (default `qwen=http://127.0.0.1:8000:8010`);
see `.env.example` for the full list of env vars, including the dream page's `GBRAIN_LOG_PATH`,
`GBRAIN_BRAIN_DIR` and `GBRAIN_DREAM_PLIST`.

## Architecture

### Server (`server/`)
- `config.ts` — one frozen object reading `process.env` with typed defaults, including the parsed
  `targets` array.
- `targets.ts` — parses `RAPID_MLX_TARGETS` (`id=<upstreamUrl>[:<proxyPort>][|<label>]`, comma
  separated) into `Target[]`. Phase 1 uses exactly one; the array shape is what Phase 3 extends
  without a code change. `proxyPort` is parsed now but unused until the Phase 2 capture proxy.
- `types.ts` — `RingBuffers` and `StatePayload` (the shape this server emits to browsers — used
  identically for the initial SSE `snapshot` and every later `tick`; `upstreamOk` is always `null`
  in this phase, since there is no capture proxy to report on).
- `promParse.ts` — pure Prometheus text exposition parser: text in, `{name, labels, value}[]` out.
  No I/O, no state. The metric family set is discovered here, never assumed.
- `promSeries.ts` — `seriesName()` derives the stable DB key for a sample (labels sorted,
  percent-encoded, `model`/`family` dropped — see the Data model section); `CounterState` turns
  cumulative counters into per-interval deltas, returning `null` on first-sight or on a decrease
  (a restart, never substituted with a fabricated value); `detectRestart()` is the
  uptime-went-backwards half of run detection.
- `runTracker.ts` — `RunTracker.observe()` is the other half of run detection: it derives
  `started_at` from `now - uptime_seconds * 1000` **once**, at first observation and again only
  when a restart is detected, then holds it stable (recomputing every scrape would wander the
  origin by a few ms and mint a new `run` row roughly once a second against the unique index).
  Restart is declared on either an uptime decrease *or* the derived origin landing more than 30s
  after the last successful observation (catches a restart that happened entirely during a scrape
  outage, where the naive decrease test sees nothing). Upserts `run` rows via `store.upsertRun()`.
- `promScraper.ts` — the core poll loop (replaces the old MTPLX-era `metricsPoller.ts`, which is
  deleted). Fetches `GET {target.upstreamUrl}/metrics` via a recursive `setTimeout` (so the delay
  can grow under failure and shrink back on success — retry/backoff capped at `MAX_BACKOFF_MS`),
  parses it, feeds `runTracker.observe()`, derives the four sparkline samples, pushes the
  `rings.{decode,prefill,ttft,accept}` buffers (capped at `RING_SIZE`, **start empty on every
  restart** — a Prometheus scrape has no rolling-window equivalent to MTPLX's `recent[]` to seed
  from, and depth rebuilds live rather than being fabricated), and persists gauges on its own
  slower cadence (see SQLite persistence below). Owns `scrapeOk`/`lastOkAt`/`lastChangeAt`.
  Exports `start()`/`stop()`/`getSnapshot()`.
- `healthPoller.ts` — repurposed low-frequency `/health` + `/v1/status` + `/v1/models` loop. No
  longer owns run identity (moved to `runTracker.ts`, which has the exact `uptime_seconds`
  signal) — what remains is caching the three JSON endpoints the scrape cannot supply:
  `engine_type`, `prompt_tps` (the only prefill-rate signal that exists — instantaneous and
  server-wide, no per-request equivalent), and `context_window`. Re-reads `/v1/models` every poll
  rather than caching it once, because a weights swap without a dashboard restart would otherwise
  bake the previous model's context window into every later `run` row.
- `db.ts` — all SQLite I/O behind a `Store` created by `createStore()`. Owns the v2 schema
  (`run`/`request`/`transcript`/`gauge`) and the bucketed range queries and prune that run against
  it; every call does a fresh `db.prepare(...)` rather than hoisting statements. Every method
  catches its own errors and degrades rather than throwing — persistence must never be able to
  break the live dashboard. Injected into `promScraper`/`healthPoller` by `server.ts`, not a
  global.
- `sse.ts` — tracks connected `Response` objects in a `Set`, writes `snapshot`/`tick` SSE events,
  and a 20s heartbeat comment so idle connections aren't reaped by any intermediary. Mechanism
  unchanged from the MTPLX era.
- `server.ts` — Express app: serves `public/` statically, `GET /api/events` (SSE — sends one
  `snapshot` on connect, then relies on `promScraper` to `broadcastTick()` on change),
  `GET /api/metrics` (plain JSON snapshot, debug/convenience only — no client code depends on it),
  `GET /api/history/series` (request-derived series only — `decode`/`ttft`, the closed
  `REQUEST_SERIES` allowlist, rejecting unknown names with HTTP 400 via `Object.hasOwn`
  — deliberately not the `in` operator, which walks the prototype chain),
  `GET /api/history/gauges` (any gauge series by name — safe because gauge names are bound as SQL
  parameters, never interpolated), `GET /api/history/gauge-names` (discovery: the distinct series
  actually persisted for a target, since the family set is not fixed — see Conventions),
  `GET /api/history/runs` and `GET /api/history/runs/:id` (run listing with per-run aggregates,
  the only endpoint that ever sends a run's full `/health`+`/v1/status`+`build_info` JSON), and
  graceful `SIGINT`/`SIGTERM` shutdown. `parseRange()` accepts `names` as either a single
  comma-joined string (safe for `REQUEST_SERIES`, whose two names never contain a comma) or
  repeated `?names=` query params collected into an array by Express — required for gauge series,
  whose names can carry more than one label and therefore a literal comma (see Conventions).

### Dream health (`public/dream.html`, `GET /api/dream/nights[/:date]`)
A fifth page, fed by parsing gbrain's append-only nightly-dream log — not by polling anything.
Fetch-on-load with a 30-second ingest cache; no SSE. Five modules, and the split between them is
load-bearing:
- `dreamParse.ts` — pure. Text in, records out; no I/O, no clock, no DB. Unrecognised lines are
  counted rather than swallowed: that count is the format-drift canary and is shown in the UI, so
  anything with its own regex (`cycling sources`, `stamped`) must never also sit in the noise list.
- `dreamAttribute.ts` — which cycle block belongs to which source. Separated because it is the
  part most likely to be wrong: a source emits a second, heavy block *after* its own stamp, so the
  intuitive "next stamp wins" rule files the busiest source's work under a trivial one. It answers
  `unknown` rather than guessing, and labels the brain-wide block `scope: 'global'`.
- `dreamSchedule.ts` — pure, injected clock. Derives expected nights from the LaunchAgent plist.
  No schedule means no missed-night claims (never a hardcoded hour). The window is derived from
  local calendar days over the evidence the caller vouches for — widening it past that overwrites
  nights an earlier pass got right.
- `dreamIngest.ts` — the only module that touches the outside world: reads the log from a stored
  byte offset, shells `git log --since=<oldest parsed run>` in the brain repo, writes through the
  store. `unavailable` (could not check) and `none` (checked, nothing there) are different answers
  and must stay different all the way to the page.
- `dreamService.ts` — config resolution plus the cache. I/O-free at construction.

The governing rule for the whole feature is in
`docs/superpowers/specs/2026-09-05-dream-health-triage-design.md` §7: **never invent an alarm, and
never take the dashboard down.**

### Data model
rapid-mlx's `/metrics` is standard Prometheus text exposition — families, types (`counter` /
`gauge` / `histogram`), labels, no request identity anywhere. This is fundamentally different from
MTPLX's old `{ latest, recent[32], tool_parse_counters }` JSON shape: there is no "the most recent
request" object to read fields off of, only current aggregate values and cumulative counters that
must be differenced into per-interval rates. `/v1/status.requests` stays empty even while
`num_running: 1` — there is no in-flight request identity to expose either. Everything the
dashboard shows is either an instantaneous gauge, a rate derived from two consecutive scrapes of a
counter, or a histogram bucket/sum/count triple.

### Server-side history buffers
`promScraper.ts` keeps `rings.{decode,prefill,ttft,accept}` (capped at `RING_SIZE`, default 120)
so a fresh browser tab gets some depth immediately via the SSE `snapshot` rather than starting
from a single point. Unlike the MTPLX era, these are **not seeded from anything** — they start
empty on every dashboard restart and rebuild live. Do not "fix" this by synthesizing points from
counters; a fabricated history is worse than a short one.

There is no server-side log buffer in this phase — `log.html`/`detail.html` have no data source to
buffer, and the old `logSeen`/`logOrder`/`ingestLog()` machinery was deleted along with
`metricsPoller.ts`.

### SQLite persistence
Schema v2 (v1 was the MTPLX era; a version mismatch on open renames the old file aside to
`data/history-v<N>-mtplx.db` rather than migrating it — MTPLX and rapid-mlx rows are not
comparable on any axis that matters, and a migration would produce history that silently lies
across the boundary). All three tables carry `target_id TEXT NOT NULL`, ready for Phase 3's second
backend without a schema change.

- `run` — one row per detected restart. Unique index `(target_id, started_at)`. Carries `version`
  (from `build_info`), `kv_cache_dtype`, `turboquant_mode`, `spec_decode_method`, `engine_type`,
  `context_window`, and the full `/health`+`/v1/status`+`build_info` JSON as `health`. The MTPLX-only
  columns (`pid`, `runtime_mode`, `depth`, `verify_core`, `paged_kv_quantization`) are gone —
  rapid-mlx has no equivalent.
- `request` — narrowed to what a proxy can eventually observe plus what the engine can join onto
  it (`request_id`, `run_id`, `ts`, token counts, `ttft_s`/`decode_tok_s`, `outcome`, `engine_joined`,
  etc.). Empty in Phase 1 — there is no capture proxy yet, so `requestCount`/decode/ttft aggregates
  on `history.html`'s run table read as zero/`—` until Phase 2.
- `transcript` — new in this phase's schema, but unused until Phase 2 populates it (prompt/response
  bodies, independently retained on `TRANSCRIPT_RETENTION_DAYS`). Exists now so the schema doesn't
  need a second migration later.
- `gauge` — holds every series with no owning request: nearly everything rapid-mlx exposes, since
  almost nothing is currently request-scoped. `queryGauges()`/`gaugeNames()` treat names as opaque,
  parameterized strings — never interpolated, unlike `REQUEST_SERIES`.

Sparkline series are split across two sources now (spec section 5.4): `decode`/`ttft` remain
request-derived via the closed `REQUEST_SERIES` allowlist (mirroring `promScraper.ts`'s
`deriveSamples()` exactly so live and historical values cannot drift, though in Phase 1 there are
no `request` rows to derive from either); `prefill`/`accept` moved to `gauge` because neither has a
per-request source (`/v1/status.prompt_tps` is instantaneous and server-wide; `spec_decode_accept_ratio`
is server-wide and labeled by `family`/`method`). `queryRuns()` LEFT JOINs `request` onto `run`
(never `INNER`) so a run with zero requests still appears with null aggregates rather than being
dropped — which, in Phase 1, is every run.

### Change detection
`promScraper.ts` broadcasts an SSE `tick` only when the derived decode/ttft samples actually
advance (gated on `requests_processed_total` moving between scrapes) or when `scrapeOk` flips —
an idle server doesn't produce a flood of identical ticks once a second. This replaces the old
`sig()` function that lived in the deleted `metricsPoller.ts`.

### Rendering
No virtual DOM, no diffing library — each renderer function (`renderHero`, `renderThroughput`,
`renderContext`, `renderCache`, `renderQueue`, `renderOutcomes`, `renderSpecDecode`, etc. in
`index.html`) does a full `innerHTML` rewrite of its own section from the latest payload, driven by
`applyPayload()` (the function that turns an incoming SSE `snapshot`/`tick` into the same render
calls). `log.html`/`detail.html` have no renderers left — they are static explanatory panels with
no script at all.

### Sparklines
Hand-rolled inline SVG (`makeSpark()`) — no charting library. Each spark owns its own
hover/tooltip/crosshair wiring and redraws on `resize` (debounced). Colors are read from CSS
custom properties at render time via `css()` (a `getComputedStyle` helper), so dark/light mode
just works without re-running JS.

### Styling
CSS variables under `:root` define a light palette; a `@media (prefers-color-scheme: dark)` block
overrides the same variable names for dark mode. `index.html`, `log.html`, `detail.html`,
`history.html` and `dream.html` all duplicate this token block — keep them in sync when adjusting
the palette.
Layout is a 12-column CSS grid of `.card` elements with `span` modifier classes (`.hero`, `.wide`,
`.third`, `.half` in `index.html`; `history.html` only needs plain `.card`) and breakpoints at
1080px and 680px.

### Connection/offline handling
Connection state is two-dimensional per target, and the two are independent (spec section 7): a
failed scrape says nothing about whether inference is serving, and vice versa.
- `scrapeOk` — whether the last `/metrics` scrape succeeded. Drives `index.html`'s
  `body.disconnected` class / `#banner` / `.dot.offline` UI, same mechanism as the MTPLX era:
  `promScraper.ts` flips it and broadcasts a `tick` immediately (not waiting for backoff) on any
  change, and `applyPayload()` on the client reacts to it.
- `upstreamOk` — capture-proxy forward-path health. Always `null` in this phase; there is no proxy
  yet. Phase 2 makes this real. Whatever renders it must not conflate "unknown" with "down."
- The SSE connection itself dropping is unrelated to either: no custom reconnect logic, native
  `EventSource` auto-reconnect handles it, and the server's fresh `snapshot` on reconnect clears
  any client-side "disconnected" state once healthy.

`log.html`/`detail.html` hold no SSE connection in this phase, so neither dimension applies to them
— they render one static state regardless of server health. `history.html` also holds no SSE
connection; a failed fetch just leaves its own affected section showing "no data" rather than the
whole page degrading.

## Conventions to preserve

- The data-acquisition layer (scraping, retry/backoff, ring buffers, change detection, run
  detection) lives once in `server/promScraper.ts` + `server/runTracker.ts` for the whole app.
  Don't re-introduce per-page polling or duplicate that logic back into the HTML files.
- Rendering/formatting code (formatters, `makeSpark`, CSS tokens) is still intentionally
  duplicated across `public/index.html`, `public/log.html`, `public/detail.html`, and
  `public/history.html`, not factored into a shared file — match that duplication rather than
  introducing a shared frontend module for it.
- `StatePayload` (`server/types.ts`) is sent in full on every `snapshot`/`tick` — not diffed. Keep
  it that way unless payload size actually becomes a problem.
- All sparkline data in `index.html` flows through `renderSparks()`, which reads `activeRings()`
  (live `rings` vs `historyRings`, picked by whether `rangeMs` is set) and is the only call site of
  `sparks.decode/prefill/ttft/accept.render()`. Never call `sparks.*.render()` directly from a
  render function or from `applyPayload()` — that indirection is load-bearing: a direct call
  bypasses the range selector, so an incoming SSE `tick` would silently overwrite a user's selected
  historical range with live ring data, with no error and nothing obviously wrong in review.
- `history.html`'s `makeSpark()` is a deliberate fork of `index.html`'s, not a bug: it adds
  restart-marker overlays (dashed lines at each run's `startedAt`) that `index.html` has no use
  for. Don't try to reconcile the two copies into one — that's the shared-module refactor this
  project's duplication convention exists to avoid.
- The run config diff on `history.html` is intentionally scoped to the columns actually promoted
  onto `run` (`model`, `version`, `kv_cache_dtype`, `turboquant_mode`, `spec_decode_method`,
  `engine_type`, `context_window`) — never the full `/health` JSON. `profile.env` alone carries
  ~30 rapid-mlx-internal flags per run; a full diff would bury every real config change in noise
  from fields nobody set on purpose.
- The metric family set is NOT fixed — 59 families on a cold server, 73 after first traffic, 80 on
  the gemma backend. Gauge series names are discovered from the scrape and stored as data; never
  hardcode a family list. `REQUEST_SERIES` stays a closed `Object.hasOwn` allowlist for the
  opposite reason: those names are interpolated into SQL.
- `run.started_at` is derived from `uptime_seconds` ONCE, at restart detection, and held stable.
  Recomputing it per scrape wanders the origin by a few ms (uptime is float seconds, scrape timing
  jitters) and the `UNIQUE(target_id, started_at)` index then mints a new run every second.
- Counter series are stored as per-interval deltas, never cumulative totals, and a decrease means a
  restart — persist null, never a negative or a raw total.
- Gauges persist on `GAUGE_PERSIST_INTERVAL_MS`, not the poll interval, and unchanged series are
  skipped. Writing ~74 series at 1 Hz is ~6.4M rows/day.
- Sparkline renderers must tolerate a **missing element**: `makeSpark` returns an inert
  `{ render() {} }` when its element is null, and `renderSparks()` guards its caption write. Cards
  can be conditionally hidden (the spec-decode card self-hides while
  `spec_decode_attempts_total{method=mtp}` is 0, which on this deployment is always), so a null
  element is an expected permanent state, not a transient bug. Without this guard, a module-scope
  throw in the single-file inline script kills the entire page — no renderers, no SSE wiring, every
  field frozen at `—`, with nothing server-side able to observe it (the markup is served
  perfectly).
- Series names carry **labels**: `seriesName()` drops only `model` and `family`, so a series like
  spec-decode's accept ratio is keyed `spec_decode_accept_ratio{method=mtp}`, not the bare
  `spec_decode_accept_ratio`. Reading a bare name yields a permanent null that looks exactly like
  "no data yet" rather than an error — check the exact labeled key before concluding a series has
  no data. Relatedly: a gauge series name can itself contain a comma (a series with more than one
  surviving label, e.g. `suffix_decode_fallthrough_total{method=suffix,reason=batch_size}`), so
  never comma-join multiple gauge names into one query-string value — use repeated `?names=`
  params instead (see `server.ts`'s `parseRange()`).
