# History page & run comparison (Phase 2)

**Date:** 2026-07-29
**Status:** approved, ready for implementation planning

## Problem

Phase 1 ([2026-07-29-sqlite-stats-persistence-design.md](2026-07-29-sqlite-stats-persistence-design.md))
shipped goals A (longer sparklines) and C (cold forensics via `sqlite3`), and laid the data model for
goal B — run comparison — without building it. `run` already carries the config a request ran under
(promoted columns plus the full `/health` JSON), and `request.run_id` is a real foreign key with the
index a per-run aggregate query wants. Nothing reads any of it yet. This phase builds that read side:
a run table with aggregates, a two-run config diff, gauge history with restart markers, and the two
endpoints that serve them.

## Goals

- See every detected MTPLX run, newest first, with request count and decode/ttft/accept aggregates.
- Pick two runs and see exactly what changed between them, with no noise from fields nobody set.
- See the request-less gauges (session-bank usage, active/completed requests) as a real history, with
  visible markers for where each run started.

## Non-goals

- No changes to `public/index.html`'s own sparklines or its range selector — Phase 1 shipped and
  reviewed that surface; this phase does not touch it. Restart markers land only on the new page's
  own charts.
- No live updates on the new page. This is a historical/forensic view; it fetches on load and offers
  a manual refresh, not SSE.
- No deep diff of the full `/health` JSON. `profile.env` alone carries ~30 MTPLX-internal flags per
  run (19–141 KB per run observed in practice); diffing that wholesale would bury the signal in noise
  from fields nobody actually changed. The diff is scoped to the six columns already promoted onto
  `run` — exactly the ones goal B is about, since `/metrics` alone never says what the config was.

## A Phase 1 data-quality fix bundled in

While scoping the gauge charts, `session_bank_bytes`/`session_bank_entries` turned out to sample
`/health`'s `session_bank.max_bytes`/`max_entries` — the **configured ceiling**, not usage. Real data
confirms it: both are constant across 933 stored samples (51.5 GB / 48, unchanged). `/health` also
exposes `session_bank.total_nbytes` and `session_bank.entries`, the actual usage figures. This phase
redirects both gauge writers in `server/healthPoller.ts` to the usage fields, so the new charts are
meaningful from the first sample. The already-stored ceiling values (flat, one day old, low value) are
superseded going forward rather than migrated — no schema change, since `gauge` is keyed by series
name with no fixed column list.

## API

### `GET /api/history/runs?limit=20`

Newest-first array of `run` rows joined with their per-run request aggregates, in one query — not
N+1 per row:

```sql
SELECT
  run.id, run.started_at, run.detected_at, run.ended_at, run.pid, run.model,
  run.runtime_mode, run.generation_mode, run.depth, run.verify_core,
  run.paged_kv_quantization, run.context_window,
  COUNT(request.request_id)                                              AS request_count,
  AVG(<decode expr>) AS decode_avg, MIN(<decode expr>) AS decode_min, MAX(<decode expr>) AS decode_max,
  AVG(request.ttft_s)                AS ttft_avg,   MIN(request.ttft_s)   AS ttft_min,   MAX(request.ttft_s)   AS ttft_max,
  AVG(request.accept_rate)           AS accept_avg, MIN(request.accept_rate) AS accept_min, MAX(request.accept_rate) AS accept_max
FROM run
LEFT JOIN request ON request.run_id = run.id
GROUP BY run.id
ORDER BY run.started_at DESC
LIMIT ?
```

`<decode expr>` is `REQUEST_SERIES.decode` (`COALESCE(display_decode_tok_s, decode_tok_s)`) — reused
from `db.ts`, not restated, so the aggregate and the sparkline can never disagree about what "decode"
means. `LEFT JOIN` (not `INNER`) so a run with zero requests — like the real run 1, whose requests
predate Phase 1's write path landing — still appears, with `request_count: 0` and null aggregates
rather than being silently dropped. `request_run_ts(run_id, ts)` from Phase 1 makes this a single
index scan regardless of run count.

No percentiles: SQLite has no builtin, and avg/min/max already answer "did this config help" without
one.

Response shape:
```
{ runs: [{ id, startedAt, endedAt, pid, model, runtimeMode, generationMode, depth, verifyCore,
            pagedKvQuantization, contextWindow, requestCount,
            decode: {avg,min,max}, ttft: {avg,min,max}, accept: {avg,min,max} }, ...] }
```

### `GET /api/history/runs/:id`

One run, `SELECT * FROM run WHERE id = ?`, with the full `health` JSON included. This is the only
endpoint that ever sends that blob over the wire — never in the list response. 404 on an unknown id.
Backs a per-row "view raw config" expander in the UI (lazy-fetched on open), which is what gives this
endpoint an actual caller rather than shipping unused API surface.

Both endpoints follow the Phase 1 convention: a disabled or degraded store returns `{ runs: [] }` /
404, never a 500.

## Page

**New `public/history.html`**, following the existing three-page convention: hand-duplicated CSS
token block and formatters, no shared frontend module, no build step. Adds a `History` link to the
`.nav` block already present in `index.html`, `log.html`, and `detail.html`.

No SSE — `EventSource` and the live-tick machinery that `index.html`/`log.html` depend on are absent
here. The page fetches on load and offers a manual refresh button; nothing on it needs sub-minute
freshness.

**Layout, top to bottom:**

1. **Run table.** One row per run from `GET /api/history/runs`: start time, duration, model, runtime
   mode, depth, request count, avg decode/ttft/accept. Each row has a checkbox and a "view raw
   config" expander (lazy `GET /api/history/runs/:id`, pretty-printed JSON). Checking a row selects
   it for comparison; checking a third replaces whichever of the first two was checked longest ago —
   never more than two selected at once.
2. **Diff panel.** Appears once two rows are checked, computed client-side from the two run objects
   already in the fetched list (no extra request). Shows only the six promoted columns, and only the
   ones that differ between the two — `null` vs `null` counts as equal, `null` vs a value counts as a
   real difference. Two runs with identical promoted config collapse to "no config differences" rather
   than an empty table.
3. **Gauge charts.** One small chart each for `session_bank_bytes` (now usage), `session_bank_entries`
   (now usage), `active_requests`, `requests_completed`, via the existing `GET /api/history/gauges`.
   Each gets a vertical line + label at every run's `startedAt`, sourced from the already-fetched run
   list — no separate query for markers. The five `tool_parse_*` counters are deliberately **not**
   charted here: they're already live on the dashboard's Tool-Call Parsing card, and as history
   they're mostly-zero step functions that wouldn't earn a chart.

**Bucketing correctness.** These charts reuse the dense-bucket-array technique from the Phase 1 final
review fix (`public/index.html`'s `loadHistory()`): one slot per bucket across the full visible
window, each returned point placed at its true index, gaps left `null`. That specific bug — an
index-ordered array rendered as if it were time-ordered, so a burst at 03:00 and a burst at 17:00
draw as adjacent — was found once already on this project; the new charts must not reintroduce it.

## Error handling

- `PERSIST_ENABLED=0` or a degraded store: `/api/history/runs` returns `{ runs: [] }`; the page
  renders an empty-state row, not an error.
- A run with zero requests: aggregates render as `—`, the row is never hidden.
- `GET /api/history/runs/:id` on an unknown id: 404. The expander shows a plain "not found" state,
  not a stack trace.
- Every fetch on the page follows the same drop-stale-response discipline Phase 1 established for
  `loadHistory()` if more than one is ever in flight at once (in practice: table load, then diff is
  synchronous client-side, then gauge loads — no realistic race today, but the pattern is not
  reinvented if one shows up).

## Testing

Same split as Phase 1. `server/db.ts`'s new query methods (run listing with aggregates, single-run
lookup) get `node:test` coverage via the existing `tmpStore()` pattern — a second on-disk connection,
never `:memory:`. The `healthPoller.ts` gauge-source change and the new page/endpoints are verified
live against a real MTPLX server and a real browser: checkbox compare interaction, diff panel
appearing/collapsing correctly, restart-marker alignment against the gauge charts' x-axis, and the nav
link landing correctly on all three existing pages. No frontend test harness, matching the rest of the
repo.

## Out of scope

- Retention/pruning changes — Phase 1's `RETENTION_DAYS`/prune job already covers `run` and `gauge`;
  nothing new here needs its own policy.
- Any UI for triggering `store.prune()` or archiving a run manually.
- Full-text or fuzzy search over runs. At current volumes (single-digit runs per day) a flat
  newest-first list needs no search.
