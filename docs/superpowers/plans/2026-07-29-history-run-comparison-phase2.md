# History Page & Run Comparison (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read side of MTPLX run comparison: a run table with per-run aggregates, a two-run config diff, gauge history with restart markers, and a new `public/history.html` page to show all of it.

**Architecture:** Two new `Store` methods (`queryRuns`, `getRun`) in `server/db.ts` back two new Express endpoints (`GET /api/history/runs`, `GET /api/history/runs/:id`). A new framework-free page reuses the existing `GET /api/history/gauges` endpoint from Phase 1 and a divergent local copy of `makeSpark()` that adds restart-marker overlays. Along the way, a Phase 1 data-quality bug is fixed: the session-bank gauges were sampling the configured ceiling instead of actual usage.

**Tech Stack:** TypeScript, Node 22 `node:sqlite`, Express 4, `node:test` + `node:assert/strict`, framework-free inline HTML/JS — unchanged from Phase 1.

**Spec:** [`docs/superpowers/specs/2026-07-29-history-run-comparison-design.md`](../specs/2026-07-29-history-run-comparison-design.md)

**Builds on:** [`docs/superpowers/plans/2026-07-29-sqlite-stats-persistence-phase1.md`](2026-07-29-sqlite-stats-persistence-phase1.md) — Phase 1 is merged to `main`; this plan assumes its final state (`Store.currentRunId()` was removed in Phase 1's final review; `healthPoller.getCurrentRunId()`/`getModel()` remain as standalone exports).

## Global Constraints

- **One runtime dependency.** `express` is the only entry under `dependencies`. Do not run `npm install <anything>`.
- **No frontend build step, no bundler, no shared frontend module.** `public/*.html` duplication (CSS tokens, formatters, `makeSpark`) is deliberate per `CLAUDE.md` — match it, don't factor it out.
- **Persistence must never break the live dashboard.** Every new `Store` method catches its own errors via the existing `fail()` helper and returns a safe value (`[]` or `null`) — never throws to a caller.
- **Config diff is scoped to the six promoted `run` columns** (`model`, `runtimeMode`, `depth`, `verifyCore`, `pagedKvQuantization`, `contextWindow`) — never a deep diff of the full `/health` JSON, which carries a `profile.env` block of ~30 MTPLX-internal flags per run that would bury the signal in noise.
- **`db.ts` and `types.ts` cross-imports stay `import type`** — a plain import creates a real runtime require cycle under `module: commonjs`.
- **Restart markers land only on `history.html`'s own gauge charts.** Do not modify `public/index.html`'s sparklines or range selector.
- **`history.html` has no SSE and no live polling** — fetch on load, manual refresh only.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/db.ts` | modify | Adds `RunAggregate`/`RunSummary`/`RunDetail` types and `queryRuns()`/`getRun()` to `Store`. |
| `server/db.test.ts` | modify | `node:test` coverage for the two new methods. |
| `server/server.ts` | modify | Adds `GET /api/history/runs` and `GET /api/history/runs/:id`. |
| `server/healthPoller.ts` | modify | Redirects `session_bank_bytes`/`session_bank_entries` gauge writes from the config ceiling to actual usage. |
| `server/types.ts` | modify | Adds `entries`/`total_nbytes` to `HealthResponse['session_bank']`. |
| `public/history.html` | create | Run table with checkboxes, config diff panel, four gauge charts with restart markers. |
| `public/index.html`, `public/log.html`, `public/detail.html` | modify | Add a `History` link to each page's `.nav`. |
| `README.md`, `CLAUDE.md` | modify | Document the new page, endpoints, and the session-bank gauge fix. |

---

### Task 1: `queryRuns()` and `getRun()` on the store

**Files:**
- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: the existing `Store`, `RunRow`, `REQUEST_SERIES`, `tmpStore()` test helper, `runInfo()` test helper, `REC` test fixture, `RUNS`/`REQUESTS` test query constants — all already in the codebase from Phase 1.
- Produces:
  - `interface RunAggregate { avg: number | null; min: number | null; max: number | null }`
  - `interface RunSummary { id, startedAt, endedAt, pid, model, runtimeMode, generationMode, depth, verifyCore, pagedKvQuantization, contextWindow, requestCount: number, decode: RunAggregate, ttft: RunAggregate, accept: RunAggregate }`
  - `interface RunDetail { id, startedAt, detectedAt, endedAt, pid, model, runtimeMode, generationMode, depth, verifyCore, pagedKvQuantization, contextWindow, health: string }`
  - `Store.queryRuns(limit: number): RunSummary[]`
  - `Store.getRun(id: number): RunDetail | null`

- [ ] **Step 1: Write the failing tests**

Append to `server/db.test.ts` (after the last existing test, `'retentionDays of 0 prunes everything'`):

```ts
import type { RunDetail } from './db';

test('queryRuns returns an empty array when there are no runs', () => {
  const { store, cleanup } = tmpStore();
  assert.deepEqual(store.queryRuns(20), []);
  cleanup();
});

test('queryRuns includes a run with zero requests, aggregates null', () => {
  const { store, cleanup } = tmpStore();
  const runA = store.upsertRun(runInfo(100, 1_700_000_000_000), 1_700_000_001_000);
  const summaries = store.queryRuns(20);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, runA);
  assert.equal(summaries[0].requestCount, 0);
  assert.deepEqual(summaries[0].decode, { avg: null, min: null, max: null });
  assert.deepEqual(summaries[0].ttft, { avg: null, min: null, max: null });
  assert.deepEqual(summaries[0].accept, { avg: null, min: null, max: null });
  cleanup();
});

test('queryRuns aggregates requests per run and orders newest-first', () => {
  const { store, cleanup } = tmpStore();
  const runA = store.upsertRun(runInfo(100, 1_700_000_000_000, { model: 'model-a' }), 1_700_000_001_000);
  const runB = store.upsertRun(runInfo(200, 1_700_000_500_000, { model: 'model-b' }), 1_700_000_501_000);

  store.insertRequest(
    { ...REC, request_id: 'a1', display_decode_tok_s: 10, ttft_s: 1.0, drafted_by_depth: [10], accepted_by_depth: [5] },
    runA, 1_700_000_002_000
  );
  store.insertRequest(
    { ...REC, request_id: 'a2', display_decode_tok_s: 20, ttft_s: 2.0, drafted_by_depth: [10], accepted_by_depth: [10] },
    runA, 1_700_000_003_000
  );
  store.insertRequest(
    { ...REC, request_id: 'b1', display_decode_tok_s: 100, ttft_s: 0.1, drafted_by_depth: [4], accepted_by_depth: [4] },
    runB, 1_700_000_502_000
  );

  const summaries = store.queryRuns(20);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].id, runB);
  assert.equal(summaries[0].requestCount, 1);
  assert.deepEqual(summaries[0].decode, { avg: 100, min: 100, max: 100 });
  assert.equal(summaries[1].id, runA);
  assert.equal(summaries[1].requestCount, 2);
  assert.deepEqual(summaries[1].decode, { avg: 15, min: 10, max: 20 });
  assert.deepEqual(summaries[1].ttft, { avg: 1.5, min: 1.0, max: 2.0 });
  assert.deepEqual(summaries[1].accept, { avg: 0.75, min: 0.5, max: 1.0 });
  cleanup();
});

test('queryRuns respects limit', () => {
  const { store, cleanup } = tmpStore();
  store.upsertRun(runInfo(100, 1_700_000_000_000), 1_700_000_001_000);
  store.upsertRun(runInfo(200, 1_700_000_500_000), 1_700_000_501_000);
  const runC = store.upsertRun(runInfo(300, 1_700_001_000_000), 1_700_001_001_000);
  const summaries = store.queryRuns(1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, runC);
  cleanup();
});

test('a disabled store returns an empty run list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({ path: path.join(dir, 'history.db'), enabled: false, retentionDays: 30 });
  assert.deepEqual(store.queryRuns(20), []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRun returns the full run including parsed health', () => {
  const { store, cleanup } = tmpStore();
  const health = JSON.stringify({ ok: true, foo: 'bar' });
  const id = store.upsertRun(runInfo(100, 1_700_000_000_000, { depth: 3, health }), 1_700_000_001_000) as number;
  const detail = store.getRun(id) as RunDetail;
  assert.ok(detail);
  assert.equal(detail.id, id);
  assert.equal(detail.startedAt, 1_700_000_000_000);
  assert.equal(detail.depth, 3);
  assert.equal(detail.runtimeMode, 'Sustained Max MTP');
  assert.deepEqual(JSON.parse(detail.health), { ok: true, foo: 'bar' });
  cleanup();
});

test('getRun returns null for an unknown id', () => {
  const { store, cleanup } = tmpStore();
  assert.equal(store.getRun(999), null);
  cleanup();
});

test('getRun on a disabled store returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({ path: path.join(dir, 'history.db'), enabled: false, retentionDays: 30 });
  assert.equal(store.getRun(1), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `store.queryRuns is not a function` (and similarly for `getRun`).

- [ ] **Step 3: Add the new types**

In `server/db.ts`, insert immediately after the closing `}` of `RunRow` (after line 50, before the `/** Every method here has a production caller...` comment on `Store`):

```ts
export interface RunAggregate {
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface RunSummary {
  id: number;
  startedAt: number;
  endedAt: number | null;
  pid: number | null;
  model: string | null;
  runtimeMode: string | null;
  generationMode: string | null;
  depth: number | null;
  verifyCore: string | null;
  pagedKvQuantization: string | null;
  contextWindow: number | null;
  requestCount: number;
  decode: RunAggregate;
  ttft: RunAggregate;
  accept: RunAggregate;
}

export interface RunDetail {
  id: number;
  startedAt: number;
  detectedAt: number;
  endedAt: number | null;
  pid: number | null;
  model: string | null;
  runtimeMode: string | null;
  generationMode: string | null;
  depth: number | null;
  verifyCore: string | null;
  pagedKvQuantization: string | null;
  contextWindow: number | null;
  health: string;
}
```

- [ ] **Step 4: Add the methods to the `Store` interface**

In `server/db.ts`, change:

```ts
  upsertRun(info: RunInfo, now: number): number | null;
  insertRequest(rec: MetricsRecord, runId: number | null, ts: number): void;
```

to:

```ts
  upsertRun(info: RunInfo, now: number): number | null;
  queryRuns(limit: number): RunSummary[];
  getRun(id: number): RunDetail | null;
  insertRequest(rec: MetricsRecord, runId: number | null, ts: number): void;
```

- [ ] **Step 5: Add the SQL row mapper**

In `server/db.ts`, insert immediately after the `REQUEST_SERIES` constant (after line 185, before `class SqliteStore`):

```ts
/** Flat shape node:sqlite returns for the queryRuns() join — mapped to the
 *  nested RunSummary the API/UI actually want. */
interface RawRunSummaryRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  pid: number | null;
  model: string | null;
  runtime_mode: string | null;
  generation_mode: string | null;
  depth: number | null;
  verify_core: string | null;
  paged_kv_quantization: string | null;
  context_window: number | null;
  request_count: number;
  decode_avg: number | null;
  decode_min: number | null;
  decode_max: number | null;
  ttft_avg: number | null;
  ttft_min: number | null;
  ttft_max: number | null;
  accept_avg: number | null;
  accept_min: number | null;
  accept_max: number | null;
}

function toRunSummary(r: RawRunSummaryRow): RunSummary {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    pid: r.pid,
    model: r.model,
    runtimeMode: r.runtime_mode,
    generationMode: r.generation_mode,
    depth: r.depth,
    verifyCore: r.verify_core,
    pagedKvQuantization: r.paged_kv_quantization,
    contextWindow: r.context_window,
    requestCount: r.request_count,
    decode: { avg: r.decode_avg, min: r.decode_min, max: r.decode_max },
    ttft: { avg: r.ttft_avg, min: r.ttft_min, max: r.ttft_max },
    accept: { avg: r.accept_avg, min: r.accept_min, max: r.accept_max },
  };
}
```

- [ ] **Step 6: Implement `queryRuns()` and `getRun()`**

In `server/db.ts`, insert immediately after `upsertRun()`'s closing `}` (after line 271, before `insertRequest(rec: MetricsRecord, ...)`):

```ts
  queryRuns(limit: number): RunSummary[] {
    if (!this.db) return [];
    try {
      const decode = REQUEST_SERIES.decode;
      const rows = this.db
        .prepare(
          `SELECT
             run.id, run.started_at, run.ended_at, run.pid, run.model,
             run.runtime_mode, run.generation_mode, run.depth, run.verify_core,
             run.paged_kv_quantization, run.context_window,
             COUNT(request.request_id) AS request_count,
             AVG(${decode}) AS decode_avg, MIN(${decode}) AS decode_min, MAX(${decode}) AS decode_max,
             AVG(request.ttft_s) AS ttft_avg, MIN(request.ttft_s) AS ttft_min, MAX(request.ttft_s) AS ttft_max,
             AVG(request.accept_rate) AS accept_avg, MIN(request.accept_rate) AS accept_min, MAX(request.accept_rate) AS accept_max
           FROM run
           LEFT JOIN request ON request.run_id = run.id
           GROUP BY run.id
           ORDER BY run.started_at DESC
           LIMIT ?`
        )
        .all(limit) as unknown as RawRunSummaryRow[];
      return rows.map(toRunSummary);
    } catch (err) {
      this.fail('queryRuns', err);
      return [];
    }
  }

  getRun(id: number): RunDetail | null {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT * FROM run WHERE id = ?').get(id) as RunRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        startedAt: row.started_at,
        detectedAt: row.detected_at,
        endedAt: row.ended_at,
        pid: row.pid,
        model: row.model,
        runtimeMode: row.runtime_mode,
        generationMode: row.generation_mode,
        depth: row.depth,
        verifyCore: row.verify_core,
        pagedKvQuantization: row.paged_kv_quantization,
        contextWindow: row.context_window,
        health: row.health,
      };
    } catch (err) {
      this.fail('getRun', err);
      return null;
    }
  }

```

`LEFT JOIN`, not `INNER JOIN`: a run with zero requests (this happens in practice — Phase 1's own run 1 predates its request-write path landing) must still appear, with `requestCount: 0` and null aggregates, not be silently dropped. `COUNT(request.request_id)` and `AVG`/`MIN`/`MAX` over an all-NULL joined row correctly evaluate to `0` and `NULL` respectively — no special-casing needed. `REQUEST_SERIES.decode` is reused rather than restated, so this aggregate and the Phase 1 sparkline can never disagree about what "decode" means.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 29 tests (21 from Phase 1 + 8 new).

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add server/db.ts server/db.test.ts
git commit -m "$(cat <<'EOF'
Add queryRuns() and getRun() to the store

queryRuns() LEFT JOINs request onto run so a run with zero requests
still appears with null aggregates rather than being dropped. Reuses
REQUEST_SERIES.decode rather than restating the expression, so the
per-run aggregate and the Phase 1 sparkline can't disagree about what
"decode" means.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: History endpoints — `GET /api/history/runs` and `GET /api/history/runs/:id`

**Files:**
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: `Store.queryRuns(limit)`, `Store.getRun(id)` from Task 1.
- Produces:
  - `GET /api/history/runs?limit=20` → `{ runs: RunSummary[] }`. `limit` clamped to `[1, 100]`, defaulting to 20.
  - `GET /api/history/runs/:id` → `RunDetail` JSON, or 404 `{ error: 'run not found' }` for an unknown id, or 400 `{ error: 'invalid run id' }` for a non-numeric id.

- [ ] **Step 1: Add the routes**

In `server/server.ts`, insert immediately after the existing `/api/history/gauges` handler (after the closing `});` that follows `res.json(store.queryGauges(names, from, to, buckets));`, before `const server = app.listen(...)`):

```ts
app.get('/api/history/runs', (req, res) => {
  const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 20;
  res.json({ runs: store.queryRuns(limit) });
});

app.get('/api/history/runs/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid run id' });
    return;
  }
  const run = store.getRun(id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  res.json(run);
});
```

- [ ] **Step 2: Verify against the live server**

A real MTPLX server should be running at `http://127.0.0.1:8000` and `data/history.db` already holds real rows from Phase 1 (at least 2 runs).

```bash
npm run dev > /tmp/dev.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:8123/api/metrics
```

```bash
curl -s "http://127.0.0.1:8123/api/history/runs" | python3 -m json.tool
```
Expected: `{"runs": [...]}` with the real runs, newest first, each carrying `decode`/`ttft`/`accept` objects and a `requestCount`.

```bash
curl -s -o /dev/null -w "limit clamp -> %{http_code}\n" "http://127.0.0.1:8123/api/history/runs?limit=0"
curl -s "http://127.0.0.1:8123/api/history/runs?limit=1" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['runs']))"
```
Expected: 200, and exactly 1 run in the second command's output (limit clamped to at least 1, and respected when explicitly 1).

```bash
FIRST_ID=$(curl -s "http://127.0.0.1:8123/api/history/runs" | python3 -c "import json,sys; print(json.load(sys.stdin)['runs'][0]['id'])")
curl -s "http://127.0.0.1:8123/api/history/runs/$FIRST_ID" | python3 -m json.tool | head -20
curl -s -o /dev/null -w "unknown id -> %{http_code}\n" "http://127.0.0.1:8123/api/history/runs/999999"
curl -s -o /dev/null -w "non-numeric id -> %{http_code}\n" "http://127.0.0.1:8123/api/history/runs/not-a-number"
```
Expected: the first command prints a full `RunDetail` object including a `health` field containing a large JSON string; the second returns 404; the third returns 400.

```bash
pkill -f "tsx watch server/server.ts"
lsof -ti:8123 >/dev/null 2>&1 && echo "8123 STILL BOUND" || echo "port 8123 free"
```

Paste all of this output into your task report.

- [ ] **Step 3: Commit**

```bash
git add server/server.ts
git commit -m "$(cat <<'EOF'
Add GET /api/history/runs and /api/history/runs/:id

runs lists newest-first with per-run aggregates, limit clamped to
[1, 100]. /runs/:id is the only endpoint that ever sends a run's full
/health JSON over the wire.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Fix session-bank gauges to sample usage, not the config ceiling

**Files:**
- Modify: `server/types.ts`
- Modify: `server/healthPoller.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports. Behavioral change: the `session_bank_bytes`/`session_bank_entries` gauge series (already written since Phase 1) now hold `/health`'s `session_bank.total_nbytes`/`entries` (actual usage) instead of `session_bank.max_bytes`/`max_entries` (the configured ceiling). Series names are unchanged.

- [ ] **Step 1: Widen the `HealthResponse` type**

In `server/types.ts`, change:

```ts
  session_bank?: { max_entries?: number | null; max_bytes?: number | null; [k: string]: unknown };
```

to:

```ts
  session_bank?: {
    max_entries?: number | null;
    max_bytes?: number | null;
    /** Actual usage — what the session-bank gauges sample, not the ceiling above. */
    entries?: number | null;
    total_nbytes?: number | null;
    [k: string]: unknown;
  };
```

- [ ] **Step 2: Redirect the gauge writes**

In `server/healthPoller.ts`, change:

```ts
      store.insertGauge('session_bank_bytes', num(h.session_bank?.max_bytes), now);
      store.insertGauge('session_bank_entries', num(h.session_bank?.max_entries), now);
```

to:

```ts
      /* total_nbytes/entries are actual usage; max_bytes/max_entries are the
         configured ceiling and stay flat forever — sampling the ceiling
         produced a meaningless flat-line history (verified against real
         data: 933 identical samples at 51.5 GB / 48). Series names are
         unchanged; only the source field moves. */
      store.insertGauge('session_bank_bytes', num(h.session_bank?.total_nbytes), now);
      store.insertGauge('session_bank_entries', num(h.session_bank?.entries), now);
```

- [ ] **Step 3: Verify against the live server**

```bash
npm run dev > /tmp/dev.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:8123/api/metrics
sleep 6  # let at least one /health poll land (HEALTH_INTERVAL_MS default 5000)
```

```bash
curl -s http://127.0.0.1:8000/health | python3 -c "
import json,sys
sb = json.load(sys.stdin)['session_bank']
print('live session_bank.entries:', sb['entries'], '| total_nbytes:', sb['total_nbytes'])
"
sqlite3 data/history.db "SELECT series, value, datetime(ts/1000,'unixepoch') FROM gauge WHERE series IN ('session_bank_bytes','session_bank_entries') ORDER BY ts DESC LIMIT 4;"
```
Expected: the most recent stored `session_bank_entries`/`session_bank_bytes` gauge values are close to the live `entries`/`total_nbytes` figures — not the constant ceiling values (51539607552 / 48) that Phase 1's rows show for older timestamps.

```bash
npm run typecheck
pkill -f "tsx watch server/server.ts"
lsof -ti:8123 >/dev/null 2>&1 && echo "8123 STILL BOUND" || echo "port 8123 free"
```

Paste the full output of every command into your report.

- [ ] **Step 4: Commit**

```bash
git add server/types.ts server/healthPoller.ts
git commit -m "$(cat <<'EOF'
Redirect session-bank gauges to actual usage, not the config ceiling

session_bank_bytes/session_bank_entries were sampling max_bytes/
max_entries — the configured ceiling, constant for the process
lifetime. Real data confirms it: 933 identical samples. /health also
exposes total_nbytes/entries, the real usage figures; the gauge series
now sample those instead. Series names are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `public/history.html` — run table, config diff, gauge charts, restart markers

**Files:**
- Create: `public/history.html`
- Modify: `public/index.html`, `public/log.html`, `public/detail.html` (nav link only)

**Interfaces:**
- Consumes: `GET /api/history/runs` and `GET /api/history/runs/:id` (Task 2), `GET /api/history/gauges` (already shipped in Phase 1).
- Produces: no exports — a standalone page.

- [ ] **Step 1: Add the nav link to the three existing pages**

In `public/index.html`, change:

```html
    <nav class="nav">
      <a href="index.html" class="active">Dashboard</a>
      <a href="log.html">Live log</a>
    </nav>
```

to:

```html
    <nav class="nav">
      <a href="index.html" class="active">Dashboard</a>
      <a href="log.html">Live log</a>
      <a href="history.html">History</a>
    </nav>
```

In `public/log.html`, change:

```html
    <nav class="nav">
      <a href="index.html">Dashboard</a>
      <a href="log.html" class="active">Live log</a>
    </nav>
```

to:

```html
    <nav class="nav">
      <a href="index.html">Dashboard</a>
      <a href="log.html" class="active">Live log</a>
      <a href="history.html">History</a>
    </nav>
```

In `public/detail.html`, change:

```html
    <nav class="nav">
      <a href="index.html">Dashboard</a>
      <a href="log.html">Live log</a>
    </nav>
```

to:

```html
    <nav class="nav">
      <a href="index.html">Dashboard</a>
      <a href="log.html">Live log</a>
      <a href="history.html">History</a>
    </nav>
```

- [ ] **Step 2: Create `public/history.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230b0e14'/%3E%3Cpath d='M55 10 28 56h18l-5 34 31-48H52z' fill='%233b82f6'/%3E%3C/svg%3E">
<title>MTPLX — run history</title>
<style>
/* ---------------------------------------------------------------- tokens (shared with dashboard) */
:root {
  --page:        #f9f9f7;
  --surface:     #fcfcfb;
  --ink:         #0b0b0b;
  --ink-2:       #52514e;
  --muted:       #898781;
  --grid:        #e1e0d9;
  --baseline:    #c3c2b7;
  --border:      rgba(11,11,11,0.10);

  --s1: #2a78d6;
  --s2: #1baf7a;
  --s3: #eda100;
  --s4: #008300;

  --blue-track:  #b7d3f6;
  --blue-wash:   rgba(42,120,214,0.10);

  --good:        #0ca30c;
  --good-text:   #006300;
  --warning:     #fab219;
  --critical:    #d03b3b;

  --shadow: 0 1px 2px rgba(11,11,11,0.04), 0 4px 14px rgba(11,11,11,0.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page:        #0d0d0d;
    --surface:     #1a1a19;
    --ink:         #ffffff;
    --ink-2:       #c3c2b7;
    --muted:       #898781;
    --grid:        #2c2c2a;
    --baseline:    #383835;
    --border:      rgba(255,255,255,0.10);

    --s1: #3987e5;
    --s2: #199e70;
    --s3: #c98500;
    --s4: #008300;

    --blue-track:  #0d366b;
    --blue-wash:   rgba(57,135,229,0.12);

    --good:        #0ca30c;
    --good-text:   #0ca30c;

    --shadow: 0 1px 2px rgba(0,0,0,0.30), 0 4px 14px rgba(0,0,0,0.25);
  }
}

/* ---------------------------------------------------------------- base */
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--page);
  color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1360px; margin: 0 auto; padding: 20px 24px 48px; }

/* ---------------------------------------------------------------- header */
header {
  display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  padding: 6px 2px 16px;
}
.brand { font-size: 19px; font-weight: 700; letter-spacing: 0.04em; }
.brand small { font-weight: 400; color: var(--ink-2); letter-spacing: 0; margin-left: 10px; font-size: 13px; }
.nav { display: flex; gap: 4px; margin-left: 2px; }
.nav a {
  font-size: 12.5px; color: var(--ink-2); text-decoration: none;
  padding: 4px 11px; border-radius: 7px; border: 1px solid transparent;
}
.nav a:hover { color: var(--ink); background: rgba(11,11,11,0.035); }
.nav a.active { color: var(--ink); border-color: var(--border); background: var(--surface); font-weight: 600; }
@media (prefers-color-scheme: dark) { .nav a:hover { background: rgba(255,255,255,0.05); } }
.head-right { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 12.5px; color: var(--ink-2); }
.head-right .sep { color: var(--baseline); }
.btn {
  font: inherit; font-size: 12px; padding: 5px 12px;
  border: 1px solid var(--border); border-radius: 7px;
  background: var(--surface); color: var(--ink-2); cursor: pointer;
}
.btn:hover { color: var(--ink); }
.btn:disabled { opacity: 0.6; cursor: default; }

/* ---------------------------------------------------------------- grid & cards */
main { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
.card {
  grid-column: span 12;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 16px 18px 18px;
  min-width: 0;
}
.card.half { grid-column: span 6; }
@media (max-width: 680px) { .card.half { grid-column: span 12; } }

h2 {
  font-size: 11.5px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 2px;
}
.subtitle { font-size: 12px; color: var(--ink-2); margin-bottom: 12px; }
.mini-note { font-size: 11px; color: var(--muted); margin-top: 10px; }

/* ---------------------------------------------------------------- sparklines */
.spark { position: relative; height: 74px; margin-top: 10px; }
.spark svg { display: block; width: 100%; height: 100%; }
.spark .tip {
  position: absolute; pointer-events: none; display: none;
  background: var(--surface); border: 1px solid var(--border); border-radius: 7px;
  box-shadow: var(--shadow);
  padding: 4px 8px; font-size: 11px; white-space: nowrap;
  font-variant-numeric: tabular-nums; color: var(--ink); z-index: 5;
  transform: translate(-50%, -125%);
}

/* ---------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
table th, table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); }
table th {
  color: var(--muted); font-weight: 600; text-transform: uppercase;
  font-size: 10.5px; letter-spacing: 0.05em;
}
table td { font-variant-numeric: tabular-nums; }
tr.cfg-row td { background: var(--page); }
.cfg-pre {
  font: 11px ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word;
  max-height: 320px; overflow: auto; color: var(--ink-2);
}
.cfg-toggle {
  font: inherit; font-size: 11px; padding: 3px 9px;
  border: 1px solid var(--border); border-radius: 6px;
  background: transparent; color: var(--ink-2); cursor: pointer;
}
.cfg-toggle:hover { color: var(--ink); }

footer { margin-top: 22px; font-size: 11.5px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="brand">MTPLX<small>inference metrics</small></div>
    <nav class="nav">
      <a href="index.html">Dashboard</a>
      <a href="log.html">Live log</a>
      <a href="history.html" class="active">History</a>
    </nav>
    <div class="head-right">
      <span id="run-count">— runs</span>
      <span class="sep">·</span>
      <button type="button" class="btn" id="refresh-btn">Refresh</button>
    </div>
  </header>

  <main>

    <section class="card">
      <h2>Runs</h2>
      <div class="subtitle">Every detected MTPLX run, newest first. Check up to two to compare their config.</div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Started</th>
            <th>Duration</th>
            <th>Model</th>
            <th>Runtime mode</th>
            <th>Depth</th>
            <th>Requests</th>
            <th>Decode (avg / min–max)</th>
            <th>TTFT (avg / min–max)</th>
            <th>Accept</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="run-tbody">
          <tr><td colspan="11" class="mini-note">loading…</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card" id="diff-section" style="display:none">
      <h2>Compare runs</h2>
      <div class="subtitle" id="diff-subtitle"></div>
      <table>
        <thead>
          <tr><th>Field</th><th id="diff-col-a">Run A</th><th id="diff-col-b">Run B</th></tr>
        </thead>
        <tbody id="diff-body"></tbody>
      </table>
    </section>

    <section class="card half">
      <h2>Session bank usage — bytes</h2>
      <div class="spark" id="g-session_bank_bytes"></div>
    </section>

    <section class="card half">
      <h2>Session bank usage — entries</h2>
      <div class="spark" id="g-session_bank_entries"></div>
    </section>

    <section class="card half">
      <h2>Active requests</h2>
      <div class="spark" id="g-active_requests"></div>
    </section>

    <section class="card half">
      <h2>Requests completed (cumulative)</h2>
      <div class="spark" id="g-requests_completed"></div>
    </section>

  </main>

  <footer>run boundaries detected from MTPLX <code>/health</code> · dashed lines mark each run's start · no live updates on this page — use Refresh</footer>
</div>

<script>
'use strict';
const RUN_LIMIT = 20;
const GAUGE_BUCKETS = 240;

const $ = s => document.getElementById(s);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = s => (s == null ? '' : String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])));

function fmt(n, d = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return fmtInt(n);
}
function fmtStart(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDuration(startMs, endMs) {
  if (startMs == null) return '—';
  const end = endMs ?? Date.now();
  const s = Math.max(0, Math.round((end - startMs) / 1000));
  let out;
  if (s < 60) out = s + 's';
  else if (s < 3600) out = Math.floor(s / 60) + 'm';
  else if (s < 86400) out = Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  else out = Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  return out + (endMs == null ? ' (ongoing)' : '');
}
function fmtAggRange(agg, d) {
  if (!agg || agg.avg == null) return '—';
  return `${fmt(agg.avg, d)} (${fmt(agg.min, d)}–${fmt(agg.max, d)})`;
}

/* ================================================================= sparkline
   A divergent copy of index.html's makeSpark(): this page's charts need
   restart-marker overlays (dashed vertical lines at each run's start) that
   index.html's copy has no use for, so per this project's convention of
   hand-duplicated rendering code, the two copies are allowed to differ. */
function makeSpark(el, opts) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  el.appendChild(tip);
  let data = [], geom = null;

  function render(d, markers) {
    data = d.filter ? d : [];
    const vals = data.filter(v => v !== null && v !== undefined);
    const old = el.querySelector('svg');
    if (old) old.remove();
    if (vals.length < 2) { geom = null; return; }

    const w = el.clientWidth || 240, h = el.clientHeight || 74;
    const pad = 6, dotR = 4;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (opts.zeroBase) lo = Math.min(lo, 0);
    if (hi === lo) { hi += 1; lo -= 1; }
    const span = hi - lo;
    lo -= span * 0.08; hi += span * 0.08;

    const n = data.length;
    const X = i => pad + (i / (n - 1)) * (w - pad * 2 - dotR);
    const Y = v => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
    geom = { X, Y, w, h, n };

    let path = '', area = '';
    data.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const cmd = path === '' ? 'M' : 'L';
      path += `${cmd}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
    });
    const first = data.findIndex(v => v != null);
    const lastI = n - 1 - [...data].reverse().findIndex(v => v != null);
    if (first >= 0 && lastI > first) {
      area = path + `L${X(lastI).toFixed(1)},${h - 2}L${X(first).toFixed(1)},${h - 2}Z`;
    }
    const color = css(opts.color || '--s1');
    const surface = css('--surface');
    const lastV = data[lastI];

    /* Restart markers: only drawn once geom exists — a chart with fewer than
       2 data points renders nothing, same as the line/area above. */
    let markerSvg = '';
    for (const mk of markers || []) {
      if (mk.index < 0 || mk.index > n - 1) continue;
      const x = X(mk.index).toFixed(1);
      markerSvg += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${css('--muted')}" stroke-width="1" stroke-dasharray="2,2"><title>${esc(mk.label)}</title></line>`;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML =
      `<line x1="0" y1="${h - 1}" x2="${w}" y2="${h - 1}" stroke="${css('--grid')}" stroke-width="1"/>` +
      (area ? `<path d="${area}" fill="${color}" opacity="0.10"/>` : '') +
      `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      markerSvg +
      `<line class="xh" x1="0" y1="${pad}" x2="0" y2="${h - pad}" stroke="${css('--baseline')}" stroke-width="1" opacity="0"/>` +
      `<circle class="hd" r="${dotR}" fill="${color}" stroke="${surface}" stroke-width="2" opacity="0"/>` +
      (lastV != null ? `<circle cx="${X(lastI).toFixed(1)}" cy="${Y(lastV).toFixed(1)}" r="${dotR}" fill="${color}" stroke="${surface}" stroke-width="2"/>` : '');
    el.insertBefore(svg, tip);
  }

  el.addEventListener('mousemove', e => {
    if (!geom || !data.length) return;
    const r = el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width * geom.w;
    let i = Math.round((fx - 6) / (geom.w - 12 - 4) * (geom.n - 1));
    i = Math.max(0, Math.min(geom.n - 1, i));
    const v = data[i];
    if (v == null) { tip.style.display = 'none'; return; }
    const svg = el.querySelector('svg');
    const xh = svg.querySelector('.xh'), hd = svg.querySelector('.hd');
    xh.setAttribute('x1', geom.X(i)); xh.setAttribute('x2', geom.X(i)); xh.setAttribute('opacity', '0.6');
    hd.setAttribute('cx', geom.X(i)); hd.setAttribute('cy', geom.Y(v)); hd.setAttribute('opacity', '1');
    tip.style.display = 'block';
    tip.style.left = (geom.X(i) / geom.w * 100) + '%';
    tip.style.top = (geom.Y(v) / geom.h * 100) + '%';
    tip.textContent = opts.format(v);
  });
  el.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    const svg = el.querySelector('svg');
    if (svg) { svg.querySelector('.xh')?.setAttribute('opacity', '0'); svg.querySelector('.hd')?.setAttribute('opacity', '0'); }
  });
  return { render };
}

const gaugeSparks = {
  session_bank_bytes:   makeSpark($('g-session_bank_bytes'),   { color: '--s1', format: v => fmtCompact(v) + ' B', zeroBase: true }),
  session_bank_entries: makeSpark($('g-session_bank_entries'), { color: '--s2', format: v => fmtInt(v), zeroBase: true }),
  active_requests:      makeSpark($('g-active_requests'),      { color: '--s3', format: v => fmtInt(v), zeroBase: true }),
  requests_completed:   makeSpark($('g-requests_completed'),   { color: '--s4', format: v => fmtInt(v), zeroBase: true }),
};

/* ================================================================= state */
let runs = [];
let selected = []; // up to 2 run ids, FIFO eviction on a third check
let lastGaugeJson = null;
const configCache = {};

const DIFF_FIELDS = [
  ['model', 'Model'],
  ['runtimeMode', 'Runtime mode'],
  ['depth', 'MTP depth'],
  ['verifyCore', 'Verify core'],
  ['pagedKvQuantization', 'Paged KV quant'],
  ['contextWindow', 'Context window'],
];

function renderRunTable() {
  $('run-count').textContent = runs.length + (runs.length === 1 ? ' run' : ' runs');
  const tbody = $('run-tbody');
  if (!runs.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="mini-note">no runs recorded yet</td></tr>`;
    return;
  }
  tbody.innerHTML = runs.map(r => `
    <tr>
      <td><input type="checkbox" data-run-id="${r.id}" ${selected.includes(r.id) ? 'checked' : ''}></td>
      <td>${fmtStart(r.startedAt)}</td>
      <td>${fmtDuration(r.startedAt, r.endedAt)}</td>
      <td>${esc(r.model) || '—'}</td>
      <td>${esc(r.runtimeMode) || '—'}</td>
      <td>${r.depth ?? '—'}</td>
      <td>${fmtInt(r.requestCount)}</td>
      <td>${fmtAggRange(r.decode, 1)}</td>
      <td>${fmtAggRange(r.ttft, 2)}</td>
      <td>${r.accept && r.accept.avg != null ? fmt(r.accept.avg * 100, 1) + '%' : '—'}</td>
      <td><button type="button" class="cfg-toggle" data-run-id="${r.id}">config</button></td>
    </tr>
    <tr class="cfg-row" data-run-id="${r.id}" style="display:none"><td colspan="11"><pre class="cfg-pre"></pre></td></tr>
  `).join('');
}

function fmtDiffVal(v) {
  return v == null ? '—' : esc(String(v));
}

function renderDiff() {
  const box = $('diff-section');
  if (selected.length < 2) { box.style.display = 'none'; return; }
  const a = runs.find(r => r.id === selected[0]);
  const b = runs.find(r => r.id === selected[1]);
  if (!a || !b) { box.style.display = 'none'; return; }

  box.style.display = '';
  $('diff-subtitle').textContent = 'Only the fields that differ are shown. Identical config collapses to a single note.';
  $('diff-col-a').textContent = `Run #${a.id} (${fmtStart(a.startedAt)})`;
  $('diff-col-b').textContent = `Run #${b.id} (${fmtStart(b.startedAt)})`;

  const rows = DIFF_FIELDS.filter(([k]) => a[k] !== b[k]);
  $('diff-body').innerHTML = rows.length
    ? rows.map(([k, label]) => `<tr><td>${label}</td><td>${fmtDiffVal(a[k])}</td><td>${fmtDiffVal(b[k])}</td></tr>`).join('')
    : `<tr><td colspan="3" class="mini-note">no config differences</td></tr>`;
}

$('run-tbody').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  const id = Number(cb.dataset.runId);
  if (cb.checked) {
    selected.push(id);
    if (selected.length > 2) {
      const evicted = selected.shift();
      const evictedCb = document.querySelector(`input[type=checkbox][data-run-id="${evicted}"]`);
      if (evictedCb) evictedCb.checked = false;
    }
  } else {
    selected = selected.filter(x => x !== id);
  }
  renderDiff();
});

$('run-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('.cfg-toggle');
  if (!btn) return;
  const id = Number(btn.dataset.runId);
  const row = document.querySelector(`tr.cfg-row[data-run-id="${id}"]`);
  if (!row) return;
  const showing = row.style.display !== 'none';
  if (showing) { row.style.display = 'none'; return; }
  row.style.display = '';
  const pre = row.querySelector('.cfg-pre');
  if (configCache[id]) { pre.textContent = configCache[id]; return; }
  pre.textContent = 'loading…';
  try {
    const r = await fetch(`/api/history/runs/${id}`);
    if (r.status === 404) { pre.textContent = 'run not found (may have been pruned)'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const detail = await r.json();
    const pretty = JSON.stringify(JSON.parse(detail.health), null, 2);
    configCache[id] = pretty;
    pre.textContent = pretty;
  } catch {
    pre.textContent = 'failed to load config';
  }
});

/* The one place that redraws the gauge charts from whatever was last fetched
   — mirrors index.html's renderSparks()/activeRings() split so resize can
   re-render locally instead of re-fetching. */
function renderGauges() {
  const names = Object.keys(gaugeSparks);
  if (!lastGaugeJson || !runs.length) {
    for (const name of names) gaugeSparks[name].render([]);
    return;
  }
  const j = lastGaugeJson;
  const slots = Math.max(1, Math.ceil((j.to - j.from) / j.bucketMs));
  const dense = pts => {
    const out = new Array(slots).fill(null);
    for (const p of pts || []) {
      const i = Math.floor((p.ts - j.from) / j.bucketMs);
      if (i >= 0 && i < slots) out[i] = p.avg;
    }
    return out;
  };
  const markers = runs.map(rn => ({
    index: (rn.startedAt - j.from) / j.bucketMs,
    label: `Run #${rn.id} started ${fmtStart(rn.startedAt)}`,
  }));
  for (const name of names) {
    gaugeSparks[name].render(dense((j.series || {})[name]), markers);
  }
}

async function loadGauges() {
  if (!runs.length) { lastGaugeJson = null; renderGauges(); return; }
  const names = Object.keys(gaugeSparks);
  const from = runs[runs.length - 1].startedAt;
  const to = Date.now();
  try {
    const r = await fetch(`/api/history/gauges?names=${names.join(',')}&from=${from}&to=${to}&buckets=${GAUGE_BUCKETS}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    lastGaugeJson = await r.json();
  } catch {
    lastGaugeJson = null;
  }
  renderGauges();
}

async function loadRuns() {
  try {
    const r = await fetch(`/api/history/runs?limit=${RUN_LIMIT}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    runs = j.runs || [];
  } catch {
    runs = [];
  }
  renderRunTable();
  renderDiff();
  await loadGauges();
}

$('refresh-btn').addEventListener('click', async () => {
  const btn = $('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  await loadRuns();
  btn.disabled = false;
  btn.textContent = 'Refresh';
});

/* re-render gauge charts on resize (sized to their container) — no re-fetch */
let rz;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(renderGauges, 150);
});

loadRuns();
</script>
</body>
</html>
```

- [ ] **Step 3: Verify with `node --check`**

There is no bundler or typechecker covering inline page JS — a stray brace ships silently and the whole page dies. Extract and syntax-check it:

```bash
npm run dev > /tmp/dev.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:8123/api/metrics
curl -s http://127.0.0.1:8123/history.html | python3 -c "
import sys, re
h = sys.stdin.read()
m = re.search(r'<script>(.*?)</script>', h, re.S)
open('/tmp/history-page.js', 'w').write(m.group(1))
print('extracted', len(m.group(1)), 'chars')
"
node --check /tmp/history-page.js && echo "PAGE JS PARSES OK"
```
Expected: `node --check` exits cleanly.

- [ ] **Step 4: Verify in a real browser**

Use the `browse` skill (or equivalent) against `http://127.0.0.1:8123/history.html` with the dev server from Step 3 still running, and the real MTPLX-backed `data/history.db` (at least 2 runs from Phase 1's own session). Check every one of these — do not skip any:

1. Page loads with zero console errors, nav shows `History` as active, and `Dashboard`/`Live log`/`History` are all present and correctly linked.
2. The run table renders at least the runs already in `data/history.db`, newest first, with sane-looking start times, durations, and decode/ttft/accept aggregates.
3. Checking two rows shows the diff panel; unchecking one hides it again. Checking a third row evicts the first-checked one (its checkbox unchecks) rather than allowing three.
4. If the two currently-real runs differ in `runtime_mode` (they do, per the design doc's own investigation — `"Sustained Max MTP"` vs `"Sustained MTP"`), the diff panel shows exactly that row and nothing else that's actually identical between them.
5. Clicking "config" on a row expands a `<pre>` with pretty-printed JSON from `/api/history/runs/:id`; clicking again collapses it; clicking a different row's "config" does not affect the first row's expanded state.
6. All four gauge charts render (or show no line if genuinely empty — not an error) and each shows a dashed vertical line for every run boundary within the visible window; hovering a dashed line shows a native tooltip naming the run.
7. Clicking "Refresh" re-fetches without a full page reload and the run table / gauge charts still render correctly afterward.
8. Resizing the browser window redraws the gauge charts without any network request firing (check the network panel) — confirms `renderGauges()` is used on resize, not `loadGauges()`.
9. Toggle OS dark mode (or emulate `prefers-color-scheme: dark`) and confirm the page re-themes correctly — no unstyled or invisible elements.

Stop the dev server and confirm port 8123 is free when done:
```bash
pkill -f "tsx watch server/server.ts"
lsof -ti:8123 >/dev/null 2>&1 && echo "8123 STILL BOUND" || echo "port 8123 free"
```

Paste concrete evidence for each of the 9 checks above into your report — screenshots, console output, or the specific values observed, not just "looks fine".

- [ ] **Step 5: Commit**

```bash
git add public/history.html public/index.html public/log.html public/detail.html
git commit -m "$(cat <<'EOF'
Add public/history.html: run table, config diff, gauge charts

Checkboxes select up to two runs for a config diff scoped to the six
promoted run columns. Gauge charts reuse GET /api/history/gauges with
the same dense-bucket-array technique as index.html's range selector,
plus restart-marker overlays this page's own makeSpark() adds. No SSE
— fetch on load, manual refresh. Adds a History link to the nav on the
three existing pages.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no code.

- [ ] **Step 1: Update `README.md`**

Rename the section heading (it already covers three pages, not two, even before this change):

Change:
```markdown
## Two pages
```
to:
```markdown
## Pages
```

Insert a new subsection after the `### \`public/detail.html\` — Single-request detail` subsection's last paragraph (the one ending "...degrades gracefully to the preview when they're absent.") and before the line `The pages cross-link via a header nav.`:

```markdown
### `public/history.html` — Run history & comparison
Every detected MTPLX run (restart), newest first, with per-run request counts and decode/TTFT/
acceptance aggregates. Check two rows to see a config diff — scoped to the six columns actually
promoted onto a `run` row (model, runtime mode, depth, verify core, paged-KV quantization, context
window), not a deep diff of the full `/health` blob, which carries dozens of internal flags that
would bury a real change in noise. Below the table, four gauge charts (session-bank usage,
active/completed requests) show dashed markers at each run's start. Unlike the other three pages,
this one has no SSE connection — it fetches on load and offers a manual **Refresh** button, since
historical/forensic browsing has no need for sub-minute freshness.
```

Also update the now-inaccurate "The pages cross-link via a header nav." sentence's neighbors are unaffected — leave it as-is; it's still true and doesn't need a page count.

In the Quick start section, change:
```
# then open:
#   http://127.0.0.1:8123/          → dashboard
#   http://127.0.0.1:8123/log.html  → live log
```
to:
```
# then open:
#   http://127.0.0.1:8123/              → dashboard
#   http://127.0.0.1:8123/log.html      → live log
#   http://127.0.0.1:8123/history.html  → run history & comparison
```

In the "### Project layout" tree, change:
```
│   ├── server.ts          Express app: serves public/, /api/events (SSE), /api/metrics,
│   │                        /api/history/series, /api/history/gauges
```
to:
```
│   ├── server.ts          Express app: serves public/, /api/events (SSE), /api/metrics,
│   │                        /api/history/series, /api/history/gauges, /api/history/runs,
│   │                        /api/history/runs/:id
```

and change:
```
├── public/              Static frontend — plain HTML/CSS/JS, no build step
│   ├── index.html         Metrics dashboard (with live/1h/24h/7d history range selector)
│   ├── log.html           Live activity log
│   └── detail.html        Standalone single-request detail page
```
to:
```
├── public/              Static frontend — plain HTML/CSS/JS, no build step
│   ├── index.html         Metrics dashboard (with live/1h/24h/7d history range selector)
│   ├── log.html           Live activity log
│   ├── detail.html        Standalone single-request detail page
│   └── history.html       Run history: run table, config diff, gauge charts with restart markers
```

In the "How it works" section, change:
```markdown
- Both pages are light/dark aware (`prefers-color-scheme`) and degrade gracefully when MTPLX is
  unreachable (dim + reconnect banner, last values retained) or when the SSE connection itself
  drops (native `EventSource` auto-reconnect, no custom retry logic needed).
```
to:
```markdown
- `index.html`, `log.html`, and `detail.html` are light/dark aware (`prefers-color-scheme`) and
  degrade gracefully when MTPLX is unreachable (dim + reconnect banner, last values retained) or
  when the SSE connection itself drops (native `EventSource` auto-reconnect, no custom retry logic
  needed) — `detail.html` opens its own `EventSource('/api/events')` too, same as the other two.
  `history.html` is light/dark aware but holds no SSE connection at all — it's a fetch-on-load,
  manual-refresh page, not a live one.
```

Note: an earlier draft of this instruction incorrectly grouped `detail.html` with `history.html` as
having no SSE connection. Verify against `public/detail.html` before writing this edit —
`grep -n "EventSource" public/detail.html` must show it opening one, confirming it belongs with
`index.html`/`log.html` here, not with `history.html`.

- [ ] **Step 2: Update `CLAUDE.md`**

In the `server/server.ts` bullet under `### Server (\`server/\`)`, change:
```markdown
- `server.ts` — Express app: serves `public/` statically, `GET /api/events` (SSE — sends one
  `snapshot` on connect, then relies on `metricsPoller` to `broadcastTick()` on change),
  `GET /api/metrics` (plain JSON snapshot, debug/convenience only — no client code depends on it),
  `GET /api/history/series` and `GET /api/history/gauges` (bucketed history reads off `db.ts`,
  rejecting unknown series names in `/api/history/series` with HTTP 400 via `Object.hasOwn` —
  deliberately not the `in` operator, which walks the prototype chain), and graceful
  `SIGINT`/`SIGTERM` shutdown gated by a `shuttingDown` flag so the startup promise chain
  (`healthPoller.start().then(() => poller.start())`) can't start the metrics poller after
  shutdown has already begun.
```
to:
```markdown
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
```

In the `### SQLite persistence` section, change:
```markdown
### SQLite persistence
The in-memory ring/log buffers are still the live path; SQLite is the durable one. `request` holds
one row per completed request (numbers plus cheap attribution text — never prompt/response
bodies), `run` holds one row per detected MTPLX run with its `/health` config snapshot, and
`gauge` holds only the series that have no owning request (`session_bank_*`, `active_requests`,
`requests_completed`, `tool_parse_*`). Sparkline series are NOT stored as gauges — they are
derived from `request` on read via `REQUEST_SERIES`, whose expressions mirror `sample()` exactly
so live and historical values cannot drift. Writes use `INSERT OR IGNORE` on `request_id`:
MTPLX's `recent[]` replays already-stored requests after a dashboard restart, and `OR REPLACE`
would overwrite their correct `ts`.
```
to:
```markdown
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
```

In the `### Styling` section, change:
```markdown
### Styling
CSS variables under `:root` define a light palette; a `@media (prefers-color-scheme: dark)` block
overrides the same variable names for dark mode. `index.html` and `log.html` duplicate this token
block — keep them in sync when adjusting the palette. Layout is a 12-column CSS grid of `.card`
elements (`index.html`) with `span` modifier classes (`.hero`, `.wide`, `.third`, `.half`) and
breakpoints at 1080px and 680px.
```
to:
```markdown
### Styling
CSS variables under `:root` define a light palette; a `@media (prefers-color-scheme: dark)` block
overrides the same variable names for dark mode. `index.html`, `log.html`, `detail.html`, and
`history.html` all duplicate this token block — keep them in sync when adjusting the palette.
Layout is a 12-column CSS grid of `.card` elements with `span` modifier classes (`.hero`, `.wide`,
`.third`, `.half` in `index.html`; `history.html` only needs `.half`) and breakpoints at 1080px
and 680px.
```

In the `### Connection/offline handling` section, change the intro line:
```markdown
### Connection/offline handling
Two distinct failure modes map onto the same `body.disconnected` class / `#banner` / `.dot.offline`
UI on both pages:
```
to (the pre-existing "both pages" wording already understated this before Phase 2 — `detail.html`
has carried the identical pattern since Phase 1; confirm with
`grep -l "dot.offline\|class=\"dot" public/index.html public/log.html public/detail.html` before
writing this edit — it should list all three):
```markdown
### Connection/offline handling
Two distinct failure modes map onto the same `body.disconnected` class / `#banner` /
`.dot.offline` UI on `index.html`, `log.html`, and `detail.html`:
```

Then add a sentence after the existing two-point list (after the line ending "...once healthy."):
```markdown

`history.html` participates in neither: it holds no SSE connection at all, so there is no
`body.disconnected` state to manage there — a failed fetch just leaves its own affected section
showing "no data" rather than the whole page degrading.
```

In `## Conventions to preserve`, add two bullets at the end (after the existing `renderSparks()`/`activeRings()` bullet):
```markdown
- `history.html`'s `makeSpark()` is a deliberate fork of `index.html`'s, not a bug: it adds
  restart-marker overlays (dashed lines at each run's `startedAt`) that `index.html` has no use
  for. Don't try to reconcile the two copies into one — that's the shared-module refactor this
  project's duplication convention exists to avoid.
- The run config diff on `history.html` is intentionally scoped to the six columns promoted onto
  `run` (`model`, `runtime_mode`, `depth`, `verify_core`, `paged_kv_quantization`,
  `context_window`) — never the full `/health` JSON. `profile.env` alone carries ~30
  MTPLX-internal flags per run; a full diff would bury every real config change in noise from
  fields nobody set on purpose.
```

- [ ] **Step 2b: Full end-to-end verification**

A real MTPLX server should be running at `http://127.0.0.1:8000`.

1. `npm run typecheck` clean; `npm test` — 29/29.
2. Start the server, confirm `data/history.db` still has its runs (Phase 1's session data plus anything Tasks 1–4 wrote):
   ```bash
   npm run dev > /tmp/dev.log 2>&1 &
   curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:8123/api/metrics
   curl -s "http://127.0.0.1:8123/api/history/runs" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['runs']), 'runs')"
   ```
3. Confirm every page's nav includes all four links and marks the right one active:
   ```bash
   for p in index.html log.html detail.html history.html; do
     echo "=== $p"
     curl -s "http://127.0.0.1:8123/$p" | grep -o '<a href="[a-z.]*html"[^>]*>[A-Za-z ]*</a>'
   done
   ```
   Expected: each page lists all four links (`Dashboard`, `Live log`, `History` — `detail.html` has no `class="active"` on any since it's reached only via a request permalink, matching its existing behavior), and `history.html` shows `History` with `class="active"`.
4. Re-confirm the session-bank fix from Task 3 is visible end to end:
   ```bash
   curl -s http://127.0.0.1:8000/health | python3 -c "import json,sys; sb=json.load(sys.stdin)['session_bank']; print('live entries:', sb['entries'])"
   curl -s "http://127.0.0.1:8123/api/history/gauges?names=session_bank_entries&buckets=4" | python3 -m json.tool | tail -10
   ```
   The most recent bucketed value should be in the same ballpark as the live `entries` figure, not the constant `48` that Phase 1's earliest rows show.
5. Stop the server and confirm the port is free:
   ```bash
   pkill -f "tsx watch server/server.ts"
   lsof -ti:8123 >/dev/null 2>&1 && echo "8123 STILL BOUND" || echo "port 8123 free"
   ```

Paste the full output of every command into your report.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
Document history.html, the two new endpoints, and the gauge fix

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Known limitations carried from the spec

- Restart markers land only on `history.html`'s own charts — `index.html`'s sparklines are
  untouched, per the design's explicit non-goal.
- The config diff never inspects the full `/health` JSON, only the six promoted columns. The "view
  raw config" expander is the escape hatch for anyone who needs more.
- No pruning/archival UI — Phase 1's `RETENTION_DAYS` policy already governs `run` and `gauge`;
  nothing new here needs its own retention control.
