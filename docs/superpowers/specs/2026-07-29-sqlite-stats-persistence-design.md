# SQLite stats persistence

**Date:** 2026-07-29
**Status:** approved, ready for implementation planning

## Problem

The dashboard's history is entirely in-memory. `metricsPoller.ts` holds ring buffers capped at
`RING_SIZE` (120 samples) and a log buffer capped at `LOG_BUFFER_SIZE` (300 requests). Restarting
the Node server loses all of it, and even while running, 120 samples is roughly ten minutes of
history at the observed request rate. Three questions are currently unanswerable:

1. What did throughput look like an hour ago / yesterday / last week?
2. Did a config change (MTP depth, verify core, KV quantization) actually help?
3. What were the characteristics of that slow request from this morning?

## Goals

- **A — Longer sparklines.** Dashboard sparks survive restarts and can render 1h / 24h / 7d.
- **B — Run comparison.** Attribute stored metrics to the MTPLX configuration that produced them.
- **C — Cold forensics.** Data is queryable with `sqlite3` by hand, with no UI required.

## Non-goals

- Persisting prompt/response bodies (`request_messages_full`, `response_text`). Those stay in the
  in-memory log buffer and the live detail page only. This is the "stats, not logs" line.
- Live in-flight request progress. MTPLX's `/metrics` only exposes completed requests; changing
  that would require a reverse-proxy SSE tap, which is out of scope here.
- Any frontend build step, framework, or shared frontend module. The existing convention of
  hand-duplicated formatters and CSS token blocks across `public/*.html` is preserved.

## Prior art: hipdash

[daniel-farina/hipdash](https://github.com/daniel-farina/hipdash) solves an overlapping problem.
It was evaluated as a replacement for this dashboard and rejected:

- **No LICENSE file.** Default all-rights-reserved; there is no grant to fork or vendor it.
- **Requires a second service.** Its Computer and OpenCode tabs read a sidecar on `127.0.0.1:8002`
  (`/system-stats.json`, `/opencode-*.json`) that does not exist in this environment.
- **Targets a different MTPLX.** Its README states MTPLX has no `request_id` and dedups requests by
  content fingerprint; this MTPLX build does emit `request_id`. It also assumes port 8088.
- **Feature regression.** It has no equivalent of the `MTPLX_DASHBOARD_CAPTURE_BODIES` body capture,
  the per-request detail page, or the tool-call parse health panel.
- **Stack cost.** React + Vite + react-router + PM2 and two `npm install`s, against this repo's
  single runtime dependency and no build step.
- **Dormant.** Created 2026-05-13, last pushed 2026-05-14; 4 stars, 1 fork.

What is worth taking from it is the read-side bucketing technique: group by
`CAST(ts / :bucketMs AS INTEGER) * :bucketMs` so one query serves any time range at any resolution.

What is explicitly **not** taken is its schema. hipdash needs a skinny `metric_point(ts, series,
value)` table because it stores sidecar metrics that have no owning request. Every sparkline series
in this dashboard is a pure function of one request row, so storing them as metric points as well
would be 4x write amplification on data already present, and would let the two copies drift.

## Architecture

| file | status | responsibility |
|---|---|---|
| `server/db.ts` | new | Owns the `node:sqlite` `DatabaseSync` handle, DDL, prepared statements, typed read/write functions, and the prune job. Knows nothing about polling or HTTP. |
| `server/healthPoller.ts` | new | Low-frequency `/health` loop. Detects run boundaries, writes `run` rows, samples health gauges, owns the `model` string. Exports `start()`, `stop()`, `getCurrentRunId()`, `getModel()`. |
| `server/metricsPoller.ts` | changed | Hot path unchanged. Writes a `request` row from `ingestLog()` on first sight of a `request_id`; writes `tool_parse_*` gauges on change; loses `pollModelOnce()`. |
| `server/server.ts` | changed | Awaits `healthPoller`'s first poll before starting `metricsPoller`; mounts `GET /api/history/*`. |
| `server/config.ts` | changed | New env-backed settings (below). |
| `server/types.ts` | changed | Adds `persist` to `StatePayload`; adds history API response types. |
| `public/index.html` | changed | Range selector above the sparklines (Phase 1). |
| `public/history.html` | new (Phase 2) | Run table, config diff, gauge charts. |

Dependency direction is one-way: `metricsPoller -> healthPoller -> db`. `server.ts` awaits
`healthPoller`'s first successful poll before starting `metricsPoller`, so a run always exists to
attribute requests to and there is no nullable-run boot edge case.

The `/health` loop is a separate module rather than a third timer inside `metricsPoller.ts`
because that file is already the core module at 214 lines and its `pollOnce()` retry/backoff logic
should not grow a second set of failure cases. The split is on the upstream endpoint boundary
(`/metrics` vs `/health`), so each module answers one question.

### Redundant loop removed

`/health` returns `model` — the same string `/v1/models` returns in `data[0].id`. `pollModelOnce()`
and its independent 5s timer are deleted; the model chip sources from `healthPoller`. Net effect is
one fewer HTTP loop despite adding a feature.

## Schema (`PRAGMA user_version = 1`)

```sql
PRAGMA journal_mode = WAL;      -- reads never block the poller's writes
PRAGMA synchronous = NORMAL;    -- local dev tool; fsync-per-txn is not worth it
PRAGMA busy_timeout = 2000;

CREATE TABLE run (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at             INTEGER NOT NULL,   -- ms, from health.startup.started_at
  detected_at            INTEGER NOT NULL,   -- ms, when this server first saw it
  ended_at               INTEGER,            -- ms, set when a newer run supersedes it
  pid                    INTEGER,
  model                  TEXT,
  runtime_mode           TEXT,
  generation_mode        TEXT,
  depth                  INTEGER,
  verify_core            TEXT,
  paged_kv_quantization  TEXT,
  context_window         INTEGER,
  health                 TEXT NOT NULL       -- full /health JSON at run start
);
CREATE UNIQUE INDEX run_identity ON run(pid, started_at);

CREATE TABLE request (
  request_id            TEXT PRIMARY KEY,
  run_id                INTEGER REFERENCES run(id) ON DELETE SET NULL,
  ts                    INTEGER NOT NULL,    -- firstSeen ms, stamped server-side
  session_id            TEXT,

  decode_tok_s          REAL, display_decode_tok_s REAL,
  prefill_tok_s         REAL, prompt_tps           REAL,
  ttft_s                REAL, request_elapsed_s    REAL, decode_elapsed_s REAL,

  prompt_tokens         INTEGER, completion_tokens INTEGER,
  context_len           INTEGER, new_prefill_tokens INTEGER,

  mtp_depth             INTEGER,
  drafted               INTEGER, accepted INTEGER, accept_rate REAL,
  drafted_by_depth      TEXT,    accepted_by_depth TEXT,   -- JSON arrays
  bonus_tokens          INTEGER, correction_tokens INTEGER, verify_calls INTEGER,

  cache_source          TEXT,    session_cache_hit INTEGER,
  cached_tokens         INTEGER, cache_restore_time_s REAL,
  ssd_cache_hit         INTEGER, ssd_cached_tokens INTEGER,

  draft_time_s          REAL, verify_forward_time_s REAL,
  verify_eval_time_s    REAL, accept_time_s REAL,

  client_label          TEXT, model TEXT, reasoning_mode TEXT,
  tool_call_count       INTEGER,
  user_preview          TEXT                  -- request_last_user_preview, ~200 chars
);
CREATE INDEX request_ts     ON request(ts);
CREATE INDEX request_run_ts ON request(run_id, ts);

CREATE TABLE gauge (
  ts     INTEGER NOT NULL,
  series TEXT    NOT NULL,
  value  REAL
);
CREATE INDEX gauge_series_ts ON gauge(series, ts);
```

### Schema rationale

- **`drafted` / `accepted` / `accept_rate` are denormalized** alongside the raw `*_by_depth` JSON
  arrays. The arrays are retained because the per-depth acceptance breakdown needs them
  historically; the scalar sums are precomputed at write time so bucketed `AVG(accept_rate)` is an
  index scan rather than JSON parsing tens of thousands of rows. `accept_rate` is computed with the
  identical expression to `sample()` in `metricsPoller.ts` — `sum(accepted_by_depth) /
  sum(drafted_by_depth)`, null when `drafted == 0` — so live and historical sparklines cannot
  disagree.
- **Booleans are stored as INTEGER 0/1** (`session_cache_hit`, `ssd_cache_hit`), SQLite's native
  representation. Null stays null.
- **No `kv_state` table.** hipdash needs one to remember last-seen signatures; here the current run
  is `SELECT id FROM run ORDER BY started_at DESC LIMIT 1`.
- **`gauge` holds only request-less series:** `session_bank_bytes`, `session_bank_entries`,
  `active_requests`, `requests_completed`, and the five cumulative `tool_parse_*` counters
  (`tool_parse_success`, `tool_parse_fallback`, `unknown_tool_name`, `malformed_tool_call`,
  `unclosed_tool_call`). Counters are stored as reported (cumulative); rate is a read-side
  difference. Nothing that a `request` row already implies is stored here.

## Data flow

### Write path

1. **Run detection.** Each `/health` poll computes identity `${startup.pid}:${startup.started_at}`
   from the raw field values. On change: stamp `ended_at = now` on the previous run, then
   `INSERT OR IGNORE INTO run` with the promoted columns and the full health JSON. Update the
   in-memory `currentRunId`. Note that `/health` reports `startup.started_at` as **float seconds**
   (e.g. `1785316775.910559`); it is converted to integer milliseconds via `Math.round(v * 1000)`
   for the `run.started_at` column, so that every timestamp in the schema is uniformly ms.
2. **Health gauges.** Written once per `/health` poll from `session_bank`, `active_requests`,
   `requests_completed`.
3. **Request rows.** Inside `ingestLog()`, for each `request_id` not already in `logSeen`:
   `INSERT OR IGNORE INTO request (...)` with `run_id = getCurrentRunId()` and `ts = firstSeen`.
4. **Tool-parse gauges.** Written from `metricsPoller` only when `tool_parse_counters` changes, not
   on every poll.
5. **Prune.** A `setInterval` at `PRUNE_INTERVAL_MS` deletes `request` and `gauge` rows older than
   `RETENTION_DAYS`, and `run` rows whose `ended_at` is older than the cutoff. No `VACUUM` — WAL
   reuses free pages, and a blocking vacuum on a live DB is not worth it.

`INSERT OR IGNORE` on `request_id` is load-bearing. When the *dashboard* restarts, MTPLX's
`recent[]` still holds up to 32 requests that already have rows. Plain `INSERT` would throw on the
primary key; `INSERT OR REPLACE` would overwrite their correct `ts` with a fresh "just now" stamp,
reintroducing the exact historical-accuracy bug the in-memory `firstSeen` design already solved.

**Known limitation:** requests that completed while the dashboard was down get an approximate `ts`
(first-sight time, not completion time) if they are still in MTPLX's `recent[]` window when the
dashboard comes back. `/metrics` exposes no completion timestamp, so this is unavoidable. The error
is bounded by MTPLX's 32-record window.

### Read path

`GET /api/history/series?names=decode,prefill,ttft,accept&from=<ms>&to=<ms>&buckets=240`

Computes `bucketMs = max(1, ceil((to - from) / buckets))` and groups on
`CAST((ts - :from) / :bucketMs AS INTEGER)`. Response:

```
{ from, to, bucketMs,
  series: { decode: [{ ts, avg, min, max, n }, ...], ... } }
```

`names` maps to expressions over `request`, not to stored column names directly:
`decode -> COALESCE(display_decode_tok_s, decode_tok_s)`, `prefill -> COALESCE(prefill_tok_s,
prompt_tps)`, `ttft -> ttft_s`, `accept -> accept_rate`. Unknown names are rejected with 400 and
never interpolated into SQL — the name-to-expression map is a closed allowlist.

`GET /api/history/gauges?names=...&from=&to=&buckets=` — same shape over `gauge`.

Phase 2 adds:
- `GET /api/history/runs?limit=20` — run rows plus per-run aggregates (request count, avg/min/max
  of decode, ttft, accept_rate). Averages and extrema only; no percentiles, since SQLite has no
  percentile builtin and they are not needed to answer "did this config help".
- `GET /api/history/runs/:id` — one run including its full health JSON.

## Error handling

Persistence must never be able to break the live dashboard.

- Every write in `db.ts` is wrapped. Failures set a degraded flag and log **once per failure class**
  rather than once per row, so a full disk does not produce a log line per request.
- `StatePayload` gains `persist: { enabled: boolean, ok: boolean, lastError: string | null }`, so
  both pages can surface a subtle indicator. SSE broadcast behaviour is otherwise unchanged.
- `PERSIST_ENABLED=0` makes `db.ts` a no-op throughout; the server then behaves exactly as it does
  today, which is also the fallback if SQLite cannot be opened at all.
- A `/health` poll failure leaves `currentRunId` at its last value and does not stop request writes.
  `healthPoller` retries on a fixed interval; it does not need the metrics loop's backoff, since it
  is already low-frequency.
- Schema version is tracked in `PRAGMA user_version`. Because this DB holds derived data, a future
  migration is permitted to drop and recreate rather than block startup.

## Configuration

| env | default | meaning |
|---|---|---|
| `DB_PATH` | `data/history.db` | SQLite file location. Directory created on boot; gitignored. |
| `PERSIST_ENABLED` | `1` | `0` disables all persistence. |
| `RETENTION_DAYS` | `30` | Prune cutoff. `0` prunes everything (used in verification). |
| `PRUNE_INTERVAL_MS` | `3600000` | Prune cadence. |
| `HEALTH_INTERVAL_MS` | `5000` | `/health` poll cadence; also drives the model chip. |

`node:sqlite` is used rather than `better-sqlite3`, keeping the repo at one runtime dependency
(`express`) with no native build step. It emits an `ExperimentalWarning` on boot, silenced with
`NODE_OPTIONS=--disable-warning=ExperimentalWarning` in the `dev`/`start` npm scripts. `engines.node`
moves from `>=20` to `>=22.5`.

`data/` is added to `.gitignore`.

## Verification

There is no automated test suite in this repo, per CLAUDE.md. Verification is manual against a live
MTPLX:

1. `npm run typecheck` passes.
2. Start the server, drive some requests, confirm `request` and `gauge` rows accumulate and a `run`
   row exists with the live server's `pid`.
3. **Cross-check live vs stored.** Query `/api/history/series` over a window that overlaps the
   in-memory ring and confirm the values match the rendered sparkline. They must, since both use
   the same `accept_rate` expression; a mismatch proves the writer wrong.
4. Restart MTPLX; confirm a second `run` row appears with the new pid and the previous run's
   `ended_at` is set.
5. Restart the dashboard while MTPLX keeps running; confirm no duplicate-key errors and that
   already-stored rows keep their original `ts`.
6. Set `RETENTION_DAYS=0`, wait one prune interval (or restart), confirm tables empty.
7. Set `PERSIST_ENABLED=0`; confirm the dashboard behaves identically to today.
8. Point `DB_PATH` at an unwritable path; confirm the dashboard still serves live data with the
   degraded indicator set.

## Phasing

**Phase 1** — `db.ts`, `healthPoller.ts`, `run`/`request`/`gauge` writes, prune job,
`GET /api/history/series`, `pollModelOnce()` removal, and a range selector (live / 1h / 24h / 7d)
above the sparklines in `index.html`. Satisfies goals A and C.

**Phase 2** — `public/history.html`: run table with aggregates, config diff between two runs,
gauge charts, restart markers. Adds `/api/history/runs` and `/api/history/runs/:id`. Satisfies
goal B.

Documentation updates (README env table, CLAUDE.md architecture section) land with Phase 1.
