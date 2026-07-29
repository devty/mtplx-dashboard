# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A realtime dashboard for a local MTPLX inference server (MTP/speculative-decoding LLM inference
on Apple Silicon). A small Node/TypeScript server (`server/`) polls MTPLX's `/metrics` endpoint
itself on an interval and pushes updates to connected browsers over Server-Sent Events. The four
pages remain plain, framework-free HTML/CSS/JS with everything inline:

- `public/index.html` — metrics dashboard (speculative-decoding hero stats, throughput, latency,
  context, verify-time breakdown, KV cache, tool-call parse health)
- `public/log.html` — live activity log (one row per completed request, expandable detail drawer)
- `public/detail.html` — standalone single-request detail page, reached via a permalink from the
  log's detail drawer
- `public/history.html` — run history & comparison (per-run aggregates, config diff, gauge charts)

`index.html`, `log.html`, and `detail.html` connect to the same `GET /api/events` SSE endpoint on
this server and render off a shared `StatePayload` shape (see `server/types.ts`); `history.html`
is fetch-on-load only and holds no SSE connection (see Connection/offline handling below). There
is still no shared JS *file* between any of the four pages, so rendering/formatting logic (not
data acquisition — see below) remains hand-duplicated across them.

## Running / testing

```bash
npm install
npm run dev              # tsx watch server/server.ts — auto-restarts on change
# http://127.0.0.1:8123/              → dashboard
# http://127.0.0.1:8123/log.html      → live log
# http://127.0.0.1:8123/history.html  → run history & comparison

npm run build && npm start   # production: compile once, run plain node
npm run typecheck             # tsc --noEmit
```

`npm test` runs `node:test` unit tests for `server/db.ts` against a throwaway on-disk SQLite file
in a temp directory — not `:memory:`, because an in-memory database is private to the connection
that opened it and the tests assert through a second read connection. Everything else is still
verified by loading the pages against a real MTPLX — there is no frontend test harness. The server
polls a single configured MTPLX target via `MTPLX_URL` (default `http://127.0.0.1:8000`); see
`.env.example` / README for the full list of env vars (`PORT`, `POLL_INTERVAL_MS`,
`MTPLX_TIMEOUT_MS`, `RING_SIZE`, `LOG_BUFFER_SIZE`, `MAX_BACKOFF_MS`, `DB_PATH`, `PERSIST_ENABLED`,
`RETENTION_DAYS`, `PRUNE_INTERVAL_MS`, `HEALTH_INTERVAL_MS`). There is no `?server=` query-param
override anymore — polling happens once, server-side, not per browser tab.

## Architecture

### Server (`server/`)
- `config.ts` — one frozen object reading `process.env` with typed defaults.
- `types.ts` — `MetricsRecord`/`ToolParseCounters`/`MtplxMetricsResponse` (the shape MTPLX's
  `/metrics` returns) and `StatePayload` (the shape this server emits to browsers — used
  identically for the initial SSE `snapshot` and every later `tick`).
- `metricsPoller.ts` — the core module. Polls `GET {MTPLX_URL}/metrics` via a recursive
  `setTimeout` (not `setInterval`, so the delay can grow under failure and shrink back on
  success — this is the retry/backoff mechanism, capped at `MAX_BACKOFF_MS`). Owns the
  server-side ring buffers and log buffer (see below), the `sig()`-based change detection, and
  `connected`/`lastOkAt`/`lastChangeAt` state. It no longer polls `/v1/models` itself — the model
  string it reports in `getSnapshot()` comes from `healthPoller.getModel()`. Every first-seen
  `request_id` is also mirrored into SQLite via `store.insertRequest()`, tagged with
  `healthPoller.getCurrentRunId()`. Exports `start()`/`stop()`/`getSnapshot()`.
- `db.ts` — all SQLite I/O behind a `Store` created by `createStore()`. Owns the v1 schema
  (`run`/`request`/`gauge`) and the bucketed range queries and prune that run against it; every
  call does a fresh `db.prepare(...)` rather than hoisting statements (at roughly one write per
  second this is not worth the added complexity). Every method catches its own errors and
  degrades rather than throwing — persistence must never be able to break the live dashboard.
  Injected into the pollers by `server.ts`, not a global.
- `healthPoller.ts` — low-frequency `/health` loop. Detects MTPLX restarts exactly via
  `startup.pid` + `startup.started_at`, writes `run` rows with the full health JSON, samples the
  request-less gauges, and owns the model string (which is why `metricsPoller` no longer polls
  `/v1/models`).
- `sse.ts` — tracks connected `Response` objects in a `Set`, writes `snapshot`/`tick` SSE events,
  and a 20s heartbeat comment so idle connections aren't reaped by any intermediary.
- `server.ts` — Express app: serves `public/` statically, `GET /api/events` (SSE — sends one
  `snapshot` on connect, then relies on `metricsPoller` to `broadcastTick()` on change),
  `GET /api/metrics` (plain JSON snapshot, debug/convenience only — no client code depends on it),
  `GET /api/history/series` and `GET /api/history/gauges` (bucketed history reads off `db.ts`,
  rejecting unknown series names in `/api/history/series` with HTTP 400 via `Object.hasOwn` —
  deliberately not the `in` operator, which walks the prototype chain), `GET /api/history/runs`
  and `GET /api/history/runs/:id` (run listing with per-run aggregates, and the only endpoint
  that ever sends a run's full `/health` JSON), and graceful `SIGINT`/`SIGTERM` shutdown gated by
  a `shuttingDown` flag so the startup promise chain
  (`healthPoller.start().then(() => poller.start())`) can't start the metrics poller after
  shutdown has already begun.

### Data model
MTPLX's `/metrics` response (`MtplxMetricsResponse`) is unchanged upstream:
```
{ latest: {...}, recent: [...up to 32 past records...], tool_parse_counters: {...} }
```
`latest` is the most recent completed request; `recent` is MTPLX's own rolling window. Everything
is keyed off *completed* requests — an in-flight generation is invisible until it finishes, since
that's all `/metrics` exposes. The Node server is now the single poller and sole source of truth
for `connected`/history — browsers never talk to MTPLX directly.

### Server-side history buffers
Since MTPLX only exposes the last ~32 records, `metricsPoller.ts` keeps its own longer-lived
buffers so a fresh browser tab or reload gets deep history immediately via the SSE `snapshot`,
not just MTPLX's last-32:
- `rings.{decode,prefill,ttft,accept}` arrays, capped at `config.ringSize` (`RING_SIZE`, default
  120), seeded from `data.recent` on the first successful poll (`seeded` flag in `pollOnce()`).
- `logSeen` (a `Map` keyed by `request_id`) plus `logOrder` (newest-first array), capped at
  `config.logBufferSize` (`LOG_BUFFER_SIZE`, default 300) via `ingestLog()`. `firstSeen` is
  stamped once, server-side, the moment a `request_id` is first observed — globally, not per
  browser tab — so a new tab shows historically-accurate arrival times instead of "just now".

On the client, `public/log.html`'s `seen`/`order` are now just a local mirror of "what's already
rendered" (so `render()` only inserts new DOM nodes and open detail-drawers survive) — the actual
dedup/trim happens in `ingestLog()` server-side.

### SQLite persistence
The in-memory ring/log buffers are still the live path; SQLite is the durable one. `request` holds
one row per completed request (numbers plus cheap attribution text — never prompt/response
bodies), `run` holds one row per detected MTPLX run with its `/health` config snapshot, and
`gauge` holds only the series that have no owning request (`session_bank_*`, `active_requests`,
`requests_completed`, `tool_parse_*`). `session_bank_bytes`/`session_bank_entries` sample
`/health`'s `session_bank.total_nbytes`/`entries` (actual usage) — NOT `max_bytes`/`max_entries`
(the configured ceiling, constant for the process lifetime). Getting this backwards is an easy
mistake since the field names read plausibly either way; it happened once already (Phase 1) and
produced a flat-line gauge history. Sparkline series are NOT stored as gauges — they are
derived from `request` on read via `REQUEST_SERIES`, whose expressions mirror `sample()` exactly
so live and historical values cannot drift. Writes use `INSERT OR IGNORE` on `request_id`:
MTPLX's `recent[]` replays already-stored requests after a dashboard restart, and `OR REPLACE`
would overwrite their correct `ts`. `queryRuns()` LEFT JOINs `request` onto `run` (never `INNER`)
so a run with zero requests still appears with null aggregates rather than being dropped.

### Change detection
`sig()` in `metricsPoller.ts` (session_id + elapsed + token counts + ttft) detects whether
`latest` actually changed between polls. This now gates two things: whether to push into the ring
buffers, and whether to broadcast an SSE `tick` at all — MTPLX being idle doesn't produce a flood
of identical ticks once a second.

### Rendering (unchanged from before the server migration)
No virtual DOM, no diffing library — each renderer function (`renderHero`, `renderThroughput`,
`renderContext`, etc. in `index.html`; `buildRow`/`buildDetail` in `log.html`) does a full
`innerHTML` rewrite of its own section from the latest metrics object, driven by `applyPayload()`
(the function that turns an incoming SSE `snapshot`/`tick` payload into the same render calls the
old per-page poll loop used to make). `log.html`'s feed is the exception: `render()` only inserts
DOM nodes for `request_id`s not already present, so open detail-drawers and scroll position
survive.

### Sparklines
Hand-rolled inline SVG in `index.html` (`makeSpark()`) — no charting library. Each spark owns its
own hover/tooltip/crosshair wiring and redraws on `resize` (debounced). Colors are read from CSS
custom properties at render time via `css()` (a `getComputedStyle` helper), so dark/light mode
just works without re-running JS.

### Styling
CSS variables under `:root` define a light palette; a `@media (prefers-color-scheme: dark)` block
overrides the same variable names for dark mode. `index.html`, `log.html`, `detail.html`, and
`history.html` all duplicate this token block — keep them in sync when adjusting the palette.
Layout is a 12-column CSS grid of `.card` elements with `span` modifier classes (`.hero`, `.wide`,
`.third`, `.half` in `index.html`; `history.html` only needs `.half`) and breakpoints at 1080px
and 680px.

### Connection/offline handling
Two distinct failure modes map onto the same `body.disconnected` class / `#banner` /
`.dot.offline` UI on `index.html`, `log.html`, and `detail.html`:
1. **MTPLX unreachable, Node server fine** — `metricsPoller.ts` flips `connected` false and
   broadcasts a `tick` immediately (not waiting for backoff); `applyPayload()` on the client sets
   `body.disconnected` from the payload.
2. **The SSE connection itself drops** — no custom reconnect logic; native `EventSource`
   auto-reconnect handles it. `es.onerror` flips `disconnected` locally in the meantime, and on
   reconnect the server's `/api/events` handler sends a fresh `snapshot` which clears it again
   once healthy.

`history.html` participates in neither: it holds no SSE connection at all, so there is no
`body.disconnected` state to manage there — a failed fetch just leaves its own affected section
showing "no data" rather than the whole page degrading.

## Conventions to preserve

- The data-acquisition layer (polling, retry/backoff, ring/log buffers, change detection) is
  genuinely shared now — it lives once in `server/metricsPoller.ts` for both pages. Don't
  re-introduce per-page polling or duplicate that logic back into the HTML files.
- Rendering/formatting code (formatters, `makeSpark`, CSS tokens) is still intentionally
  duplicated across `public/index.html`, `public/log.html`, `public/detail.html`, and
  `public/history.html`, not factored into a shared file — match that duplication rather than
  introducing a shared frontend module for it.
- When adding a new metric field, mirror the existing pattern: add it to `MetricsRecord` in
  `server/types.ts` if it needs typed access, a `fmt*` helper for display, a dedicated `#id`
  element already present in the markup or added alongside similar ones, and a render function
  that no-ops gracefully (`—`) when the field is `null`/`undefined`.
- `StatePayload` (`server/types.ts`) is sent in full on every `snapshot`/`tick` — not diffed. Keep
  it that way unless payload size actually becomes a problem; diffing is not worth the complexity
  at this project's scale (broadcasts only happen on genuine change, not every poll tick).
- All sparkline data in `index.html` flows through `renderSparks()`, which reads `activeRings()`
  (live `rings` vs `historyRings`, picked by whether `rangeMs` is set) and is the only call site of
  `sparks.decode/prefill/ttft/accept.render()`. Never call `sparks.*.render()` directly from a
  render function or from `applyPayload()` — `applyPayload()` correctly calls `renderSparks()`
  rather than rendering `rings` itself, and that indirection is load-bearing: a direct call bypasses
  the range selector, so an incoming SSE `tick` would silently overwrite a user's selected
  historical range with live ring data, with no error and nothing obviously wrong in review.
- `history.html`'s `makeSpark()` is a deliberate fork of `index.html`'s, not a bug: it adds
  restart-marker overlays (dashed lines at each run's `startedAt`) that `index.html` has no use
  for. Don't try to reconcile the two copies into one — that's the shared-module refactor this
  project's duplication convention exists to avoid.
- The run config diff on `history.html` is intentionally scoped to the six columns promoted onto
  `run` (`model`, `runtime_mode`, `depth`, `verify_core`, `paged_kv_quantization`,
  `context_window`) — never the full `/health` JSON. `profile.env` alone carries ~30
  MTPLX-internal flags per run; a full diff would bury every real config change in noise from
  fields nobody set on purpose.
