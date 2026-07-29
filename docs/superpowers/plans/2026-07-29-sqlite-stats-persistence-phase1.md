# SQLite Stats Persistence — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-request MTPLX stats, run boundaries, and request-less gauges to a local SQLite database, and let the dashboard's sparklines render 1h / 24h / 7d ranges from it.

**Architecture:** A new `server/db.ts` owns all SQLite I/O behind a `Store` interface created by a `createStore()` factory (injected, not a hidden global, so it can be tested against `:memory:`). A new `server/healthPoller.ts` polls MTPLX `/health` on a slow loop, detects run boundaries from `startup.pid` + `startup.started_at`, writes `run` rows and health gauges, and takes over ownership of the model string. `server/metricsPoller.ts` keeps its hot path untouched and gains a single request-insert call inside `ingestLog()`. A new `GET /api/history/series` endpoint serves bucketed aggregates, and `public/index.html` gains a range selector that swaps the sparklines between the in-memory ring and the database.

**Tech Stack:** TypeScript, Node 22 `node:sqlite` (`DatabaseSync`), Express 4, `node:test` + `node:assert/strict`, framework-free inline HTML/JS.

**Spec:** [`docs/superpowers/specs/2026-07-29-sqlite-stats-persistence-design.md`](../specs/2026-07-29-sqlite-stats-persistence-design.md)

## Global Constraints

- **One runtime dependency.** `express` is the only entry allowed under `dependencies`. Use `node:sqlite`, never `better-sqlite3`. Test tooling uses built-in `node:test` / `node:assert` — no test framework dependency.
- **Node floor is `>=22.5`.** `package.json` `engines.node` moves from `>=20` to `>=22.5`.
- **`node:sqlite` emits `ExperimentalWarning` on import.** Every npm script that loads it passes `--disable-warning=ExperimentalWarning`.
- **Persistence must never break the live dashboard.** Every `Store` method catches its own errors, records them, and returns a safe value. No `Store` call may throw to a caller.
- **`node:sqlite` bind values must be `number | string | bigint | null | Uint8Array`.** Booleans and `undefined` are runtime errors — always coerce (`undefined` → `null`, `true` → `1`).
- **All timestamps stored in the schema are integer milliseconds.** `/health` reports `startup.started_at` as float seconds; convert with `Math.round(v * 1000)`.
- **Rendering/formatting code stays hand-duplicated across `public/*.html`.** Do not introduce a shared frontend JS module or a build step.
- **Schema version is `PRAGMA user_version = 1`.**
- **`db.ts` and `types.ts` reference each other's types.** `db.ts` needs `MetricsRecord`, `types.ts` needs `PersistStatus`. Both directions MUST use `import type`, which TypeScript erases at compile time — a plain `import` here creates a real runtime require cycle under `module: commonjs`.
- **Retention default is 30 days**, prune interval 1 hour, both env-configurable.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/db.ts` | create | `createStore()` factory; DDL, prepared statements, typed read/write, prune. No polling or HTTP knowledge. |
| `server/db.test.ts` | create | Unit tests for `db.ts` against `:memory:`. |
| `server/healthPoller.ts` | create | `/health` loop: run detection, `run` rows, health gauges, model string. |
| `server/config.ts` | modify | Adds `dbPath`, `persistEnabled`, `retentionDays`, `pruneIntervalMs`, `healthIntervalMs`. |
| `server/types.ts` | modify | Adds `HealthResponse`, `PersistStatus`; adds `persist` to `StatePayload`. |
| `server/metricsPoller.ts` | modify | Writes request rows + tool-parse gauges; drops `pollModelOnce()`; accepts an injected `Store`. |
| `server/server.ts` | modify | Creates the `Store`, orders poller startup, mounts `/api/history/*`, closes the DB on shutdown. |
| `public/index.html` | modify | Range selector; fetches bucketed series when range ≠ live. |
| `tsconfig.json` | modify | Excludes `*.test.ts` from the build. |
| `package.json` | modify | `test` script, `engines`, warning suppression. |
| `.gitignore` | modify | Ignores `data/`. |
| `README.md`, `CLAUDE.md` | modify | Env table and architecture docs. |

---

### Task 1: Store scaffolding — schema, lifecycle, disabled mode

**Files:**
- Create: `server/db.ts`
- Create: `server/db.test.ts`
- Modify: `server/config.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createStore(options: StoreOptions): Store`
  - `interface StoreOptions { path: string; enabled: boolean; retentionDays: number }`
  - `interface PersistStatus { enabled: boolean; ok: boolean; lastError: string | null }`
  - `Store.status(): PersistStatus`
  - `Store.close(): void`
  - `SCHEMA_VERSION = 1`

**Interface discipline (applies to Tasks 1–5):** the `Store` interface carries ONLY methods with a production caller. It must never gain test-only introspection helpers (`runsForTest`, `requestsForTest`, `tableNames`, `schemaVersion`, or similar). Tests assert against stored state by opening their own second `DatabaseSync` connection to a temp-file database — see the `tmpStore()` helper in Step 2, which every later task reuses. `:memory:` is deliberately NOT used in tests, because an in-memory database is private to its connection and a second connection would see an empty database.

- [ ] **Step 1: Add the test script, engines floor, and build exclusion**

In `package.json`, replace the `scripts` and `engines` blocks:

```json
  "scripts": {
    "dev": "NODE_OPTIONS=--disable-warning=ExperimentalWarning tsx watch server/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "NODE_OPTIONS=--disable-warning=ExperimentalWarning node dist/server.js",
    "test": "node --disable-warning=ExperimentalWarning --import tsx --test server/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22.5"
  },
```

In `tsconfig.json`, add an `exclude` key as a sibling of `include` so test files never land in `dist/`:

```json
  "include": ["server/**/*.ts"],
  "exclude": ["server/**/*.test.ts"]
```

Append to `.gitignore`:

```
data/
```

- [ ] **Step 2: Write the failing test**

Create `server/db.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SCHEMA_VERSION } from './db';

/** Creates a Store backed by a throwaway file, plus an independent read
 *  connection for assertions. A second connection is why this uses a temp file
 *  rather than ':memory:' — an in-memory database is private to the connection
 *  that opened it, so a reader would see an empty schema. WAL lets both
 *  connections coexist. `read` opens read-write because a strictly read-only
 *  connection cannot create the -shm file WAL needs. */
function tmpStore(retentionDays = 30) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');
  const store = createStore({ path: file, enabled: true, retentionDays });

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

test('creates the schema and stamps the version', () => {
  const { store, read, cleanup } = tmpStore();
  assert.equal(store.status().enabled, true);
  assert.equal(store.status().ok, true);
  assert.equal(store.status().lastError, null);

  const tables = read<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).map(r => r.name);
  assert.deepEqual(tables, ['gauge', 'request', 'run']);

  const [{ user_version }] = read<{ user_version: number }>('PRAGMA user_version');
  assert.equal(user_version, SCHEMA_VERSION);
  cleanup();
});

test('disabled store is inert and never touches the filesystem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');
  const store = createStore({ path: file, enabled: false, retentionDays: 30 });

  assert.equal(store.status().enabled, false);
  assert.equal(store.status().ok, true);
  assert.equal(fs.existsSync(file), false);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unopenable path degrades instead of throwing', () => {
  /* A regular file standing where a directory must be: mkdirSync fails with
     ENOTDIR on every platform, unlike a permission-based path which depends on
     who is running the tests. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');

  const store = createStore({
    path: path.join(blocker, 'history.db'),
    enabled: true,
    retentionDays: 30,
  });
  assert.equal(store.status().ok, false);
  assert.ok(store.status().lastError);
  store.close(); // must not throw on a store that never opened

  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 4: Write the minimal implementation**

Create `server/db.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export interface StoreOptions {
  /** SQLite file path. Its parent directory is created if missing. */
  path: string;
  enabled: boolean;
  retentionDays: number;
}

export interface PersistStatus {
  enabled: boolean;
  ok: boolean;
  lastError: string | null;
}

/** Every method here has a production caller. Test-only introspection belongs
 *  in the test file's own read connection, not on this interface. */
export interface Store {
  status(): PersistStatus;
  close(): void;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS run (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at             INTEGER NOT NULL,
    detected_at            INTEGER NOT NULL,
    ended_at               INTEGER,
    pid                    INTEGER,
    model                  TEXT,
    runtime_mode           TEXT,
    generation_mode        TEXT,
    depth                  INTEGER,
    verify_core            TEXT,
    paged_kv_quantization  TEXT,
    context_window         INTEGER,
    health                 TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS run_identity ON run(pid, started_at);

  CREATE TABLE IF NOT EXISTS request (
    request_id            TEXT PRIMARY KEY,
    run_id                INTEGER REFERENCES run(id) ON DELETE SET NULL,
    ts                    INTEGER NOT NULL,
    session_id            TEXT,
    decode_tok_s          REAL,
    display_decode_tok_s  REAL,
    prefill_tok_s         REAL,
    prompt_tps            REAL,
    ttft_s                REAL,
    request_elapsed_s     REAL,
    decode_elapsed_s      REAL,
    prompt_tokens         INTEGER,
    completion_tokens     INTEGER,
    context_len           INTEGER,
    new_prefill_tokens    INTEGER,
    mtp_depth             INTEGER,
    drafted               INTEGER,
    accepted              INTEGER,
    accept_rate           REAL,
    drafted_by_depth      TEXT,
    accepted_by_depth     TEXT,
    bonus_tokens          INTEGER,
    correction_tokens     INTEGER,
    verify_calls          INTEGER,
    cache_source          TEXT,
    session_cache_hit     INTEGER,
    cached_tokens         INTEGER,
    cache_restore_time_s  REAL,
    ssd_cache_hit         INTEGER,
    ssd_cached_tokens     INTEGER,
    draft_time_s          REAL,
    verify_forward_time_s REAL,
    verify_eval_time_s    REAL,
    accept_time_s         REAL,
    client_label          TEXT,
    model                 TEXT,
    reasoning_mode        TEXT,
    tool_call_count       INTEGER,
    user_preview          TEXT
  );
  CREATE INDEX IF NOT EXISTS request_ts     ON request(ts);
  CREATE INDEX IF NOT EXISTS request_run_ts ON request(run_id, ts);

  CREATE TABLE IF NOT EXISTS gauge (
    ts     INTEGER NOT NULL,
    series TEXT    NOT NULL,
    value  REAL
  );
  CREATE INDEX IF NOT EXISTS gauge_series_ts ON gauge(series, ts);
`;

class SqliteStore implements Store {
  private db: DatabaseSync | null = null;
  private ok = true;
  private lastError: string | null = null;
  /** Failure classes already logged, so a full disk logs once, not per row. */
  private loggedClasses = new Set<string>();

  constructor(private readonly options: StoreOptions) {
    if (!options.enabled) return;
    try {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
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

  /** Records a failure and logs it at most once per class. Never rethrows. */
  protected fail(cls: string, err: unknown): void {
    this.ok = false;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (!this.loggedClasses.has(cls)) {
      this.loggedClasses.add(cls);
      console.error(`[db] ${cls} failed (further ${cls} errors suppressed): ${this.lastError}`);
    }
  }

  status(): PersistStatus {
    return { enabled: this.options.enabled, ok: this.ok, lastError: this.lastError };
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* closing a already-broken handle is not worth reporting */
    }
    this.db = null;
  }
}

export function createStore(options: StoreOptions): Store {
  return new SqliteStore(options);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 3 tests.

- [ ] **Step 6: Add the config entries**

In `server/config.ts`, add a `bool` reader above the `config` object:

```ts
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}
```

and add these five entries inside `Object.freeze({ ... })`:

```ts
  dbPath: str('DB_PATH', 'data/history.db'),
  persistEnabled: bool('PERSIST_ENABLED', true),
  retentionDays: int('RETENTION_DAYS', 30),
  pruneIntervalMs: int('PRUNE_INTERVAL_MS', 3600000),
  healthIntervalMs: int('HEALTH_INTERVAL_MS', 5000),
```

- [ ] **Step 7: Verify types and commit**

Run: `npm run typecheck && npm test`
Expected: no output from typecheck; 3 tests pass.

```bash
git add server/db.ts server/db.test.ts server/config.ts tsconfig.json package.json .gitignore
git commit -m "$(cat <<'EOF'
Add SQLite store scaffolding with schema and degraded-mode handling

Introduces server/db.ts with a createStore() factory over node:sqlite,
the v1 schema (run/request/gauge), and failure handling that degrades
instead of throwing. Adds node:test as the test runner (no new deps).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Run boundary detection and persistence

**Files:**
- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: `createStore`, `Store`, `PersistStatus` from Task 1.
- Produces:
  - `interface RunInfo { pid: number | null; startedAt: number; model: string | null; runtimeMode: string | null; generationMode: string | null; depth: number | null; verifyCore: string | null; pagedKvQuantization: string | null; contextWindow: number | null; health: string }`
  - `Store.upsertRun(info: RunInfo, now: number): number | null` — returns the run's row id, or `null` when disabled/degraded. Idempotent on `(pid, startedAt)`; stamps `ended_at = now` on any older open run.
  - `Store.currentRunId(): number | null`
  - `interface RunRow` — the shape of a `run` table row. A type only; no accessor method on `Store`. Tests read rows through `tmpStore()`'s `read` helper.

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts`:

```ts
import type { RunInfo, RunRow } from './db';

const RUNS = 'SELECT * FROM run ORDER BY id';

function runInfo(pid: number, startedAt: number, over: Partial<RunInfo> = {}): RunInfo {
  return {
    pid,
    startedAt,
    model: 'test-model',
    runtimeMode: 'Sustained Max MTP',
    generationMode: 'mtp',
    depth: 1,
    verifyCore: 'linear-gdn-from-conv-tape',
    pagedKvQuantization: 'q8',
    contextWindow: 98304,
    health: JSON.stringify({ ok: true }),
    ...over,
  };
}

test('upsertRun is idempotent for the same pid and start time', () => {
  const { store, read, cleanup } = tmpStore();
  const a = store.upsertRun(runInfo(100, 1_700_000_000_000), 1_700_000_001_000);
  const b = store.upsertRun(runInfo(100, 1_700_000_000_000), 1_700_000_002_000);
  assert.equal(typeof a, 'number');
  assert.equal(b, a);
  assert.equal(store.currentRunId(), a);
  assert.equal(read<RunRow>(RUNS).length, 1);
  cleanup();
});

test('a new run closes the previous one', () => {
  const { store, read, cleanup } = tmpStore();
  const first = store.upsertRun(runInfo(100, 1_700_000_000_000), 1_700_000_001_000);
  const second = store.upsertRun(runInfo(200, 1_700_000_500_000), 1_700_000_501_000);
  assert.notEqual(second, first);
  assert.equal(store.currentRunId(), second);

  const rows = read<RunRow>(RUNS);
  const closed = rows.find(r => r.id === first);
  const open = rows.find(r => r.id === second);
  assert.equal(closed?.ended_at, 1_700_000_501_000);
  assert.equal(open?.ended_at, null);
  cleanup();
});

test('run promotes health columns and keeps the raw JSON', () => {
  const { store, read, cleanup } = tmpStore();
  const id = store.upsertRun(runInfo(100, 1_700_000_000_000, { depth: 3 }), 1_700_000_001_000);
  const row = read<RunRow>(RUNS).find(r => r.id === id);
  assert.equal(row?.depth, 3);
  assert.equal(row?.runtime_mode, 'Sustained Max MTP');
  assert.equal(row?.paged_kv_quantization, 'q8');
  assert.deepEqual(JSON.parse(String(row?.health)), { ok: true });
  cleanup();
});

test('upsertRun on a disabled store returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: false,
    retentionDays: 30,
  });
  assert.equal(store.upsertRun(runInfo(1, 2), 3), null);
  assert.equal(store.currentRunId(), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.upsertRun is not a function`.

- [ ] **Step 3: Implement run persistence**

In `server/db.ts`, add the exported interface above `Store`:

```ts
export interface RunInfo {
  pid: number | null;
  /** Integer ms. Callers convert /health's float-seconds started_at. */
  startedAt: number;
  model: string | null;
  runtimeMode: string | null;
  generationMode: string | null;
  depth: number | null;
  verifyCore: string | null;
  pagedKvQuantization: string | null;
  contextWindow: number | null;
  /** Raw /health JSON as returned at run start. */
  health: string;
}

export interface RunRow {
  id: number;
  started_at: number;
  detected_at: number;
  ended_at: number | null;
  pid: number | null;
  model: string | null;
  runtime_mode: string | null;
  generation_mode: string | null;
  depth: number | null;
  verify_core: string | null;
  paged_kv_quantization: string | null;
  context_window: number | null;
  health: string;
}
```

Add to the `Store` interface:

```ts
  upsertRun(info: RunInfo, now: number): number | null;
  currentRunId(): number | null;
```

Add to `SqliteStore` a field and the methods:

```ts
  private runId: number | null = null;

  upsertRun(info: RunInfo, now: number): number | null {
    if (!this.db) return null;
    try {
      const existing = this.db
        .prepare('SELECT id FROM run WHERE pid IS ? AND started_at = ?')
        .get(info.pid, info.startedAt) as { id: number } | undefined;

      if (existing) {
        this.runId = existing.id;
        return existing.id;
      }

      /* Close every run still open — a fresh identity means they are all over.
         Guarded on started_at so an out-of-order poll can't close a newer run. */
      this.db
        .prepare('UPDATE run SET ended_at = ? WHERE ended_at IS NULL AND started_at < ?')
        .run(now, info.startedAt);

      this.db
        .prepare(
          `INSERT INTO run (started_at, detected_at, ended_at, pid, model, runtime_mode,
                            generation_mode, depth, verify_core, paged_kv_quantization,
                            context_window, health)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          info.startedAt,
          now,
          info.pid,
          info.model,
          info.runtimeMode,
          info.generationMode,
          info.depth,
          info.verifyCore,
          info.pagedKvQuantization,
          info.contextWindow,
          info.health
        );

      const row = this.db
        .prepare('SELECT id FROM run WHERE pid IS ? AND started_at = ?')
        .get(info.pid, info.startedAt) as { id: number };
      this.runId = row.id;
      return row.id;
    } catch (err) {
      this.fail('upsertRun', err);
      return null;
    }
  }

  currentRunId(): number | null {
    return this.runId;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "$(cat <<'EOF'
Persist MTPLX run boundaries keyed on pid and start time

upsertRun() is idempotent on (pid, started_at) and stamps ended_at on
older open runs, so restarts produce exact run windows rather than the
inferred signature heuristic hipdash needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Request row persistence

**Files:**
- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: `Store`, `RunInfo` from Tasks 1–2; `MetricsRecord` from `server/types.ts`.
- Produces:
  - `Store.insertRequest(rec: MetricsRecord, runId: number | null, ts: number): void`
  - `acceptRate(rec: MetricsRecord): number | null` (exported; must match `sample()` in `metricsPoller.ts`)

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts`:

```ts
import type { MetricsRecord } from './types';

const REC: MetricsRecord = {
  request_id: 'req-1',
  session_id: 'sess-1',
  decode_tok_s: 43.8,
  display_decode_tok_s: 44.1,
  prefill_tok_s: 411.5,
  ttft_s: 1.06,
  request_elapsed_s: 1.26,
  prompt_tokens: 436,
  completion_tokens: 9,
  drafted_by_depth: [10, 6],
  accepted_by_depth: [8, 2],
  session_cache_hit: true,
  ssd_cache_hit: false,
  cache_source: 'none',
  request_client_label: 'opencode',
  request_model: 'mtplx-qwen36',
  request_reasoning_mode: 'off',
  request_last_user_preview: 'hello there',
};

const REQUESTS = 'SELECT * FROM request ORDER BY ts';

test('insertRequest maps fields and precomputes accept_rate', () => {
  const { store, read, cleanup } = tmpStore();
  const runId = store.upsertRun(runInfo(100, 1_700_000_000_000), 1_700_000_001_000);
  store.insertRequest(REC, runId, 1_700_000_002_000);

  const rows = read(REQUESTS);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.request_id, 'req-1');
  assert.equal(r.run_id, runId);
  assert.equal(r.ts, 1_700_000_002_000);
  assert.equal(r.prompt_tokens, 436);
  assert.equal(r.drafted, 16);
  assert.equal(r.accepted, 10);
  assert.equal(r.accept_rate, 10 / 16);
  assert.deepEqual(JSON.parse(String(r.drafted_by_depth)), [10, 6]);
  assert.equal(r.client_label, 'opencode');
  assert.equal(r.user_preview, 'hello there');
  cleanup();
});

test('booleans become 0/1 and absent fields become null', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequest(REC, null, 1_700_000_002_000);
  const r = read(REQUESTS)[0];
  assert.equal(r.session_cache_hit, 1);
  assert.equal(r.ssd_cache_hit, 0);
  assert.equal(r.run_id, null);
  assert.equal(r.bonus_tokens, null);
  assert.equal(r.verify_calls, null);
  cleanup();
});

test('accept_rate is null when nothing was drafted', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequest({ ...REC, drafted_by_depth: [], accepted_by_depth: [] }, null, 1);
  assert.equal(read(REQUESTS)[0].accept_rate, null);
  cleanup();
});

test('re-inserting the same request_id preserves the original ts', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequest(REC, null, 1_700_000_002_000);
  store.insertRequest({ ...REC, prompt_tokens: 999 }, null, 1_700_000_999_000);

  const rows = read(REQUESTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, 1_700_000_002_000);
  assert.equal(rows[0].prompt_tokens, 436);
  cleanup();
});

test('a record without a request_id is skipped', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequest({ session_id: 'x' }, null, 1);
  assert.equal(read(REQUESTS).length, 0);
  cleanup();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.insertRequest is not a function`.

- [ ] **Step 3: Implement request persistence**

In `server/db.ts`, add the import at the top:

```ts
import type { MetricsRecord } from './types';
```

Add the coercion helpers and `acceptRate` above `class SqliteStore`:

```ts
/* node:sqlite accepts only number | string | bigint | null | Uint8Array as bind
   values — booleans and undefined throw at runtime, so everything is coerced. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function txt(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function flag(v: unknown): number | null {
  return typeof v === 'boolean' ? (v ? 1 : 0) : null;
}
function jsonArr(v: unknown): string | null {
  return Array.isArray(v) ? JSON.stringify(v) : null;
}
function sumArr(v: unknown): number {
  return Array.isArray(v) ? v.reduce((a: number, b) => a + (Number(b) || 0), 0) : 0;
}

/** Identical semantics to sample() in metricsPoller.ts — the live sparkline and
 *  the stored series must never be able to disagree. */
export function acceptRate(rec: MetricsRecord): number | null {
  const drafted = sumArr(rec.drafted_by_depth);
  return drafted > 0 ? sumArr(rec.accepted_by_depth) / drafted : null;
}
```

Add to the `Store` interface:

```ts
  insertRequest(rec: MetricsRecord, runId: number | null, ts: number): void;
```

Add to `SqliteStore`:

```ts
  insertRequest(rec: MetricsRecord, runId: number | null, ts: number): void {
    if (!this.db) return;
    const id = txt(rec.request_id);
    if (!id) return;
    try {
      const drafted = sumArr(rec.drafted_by_depth);
      const accepted = sumArr(rec.accepted_by_depth);
      /* OR IGNORE, never OR REPLACE: on a dashboard restart MTPLX's recent[]
         still holds already-stored requests, and REPLACE would overwrite their
         correct ts with a fresh "just now" stamp. */
      this.db
        .prepare(
          `INSERT OR IGNORE INTO request (
             request_id, run_id, ts, session_id,
             decode_tok_s, display_decode_tok_s, prefill_tok_s, prompt_tps,
             ttft_s, request_elapsed_s, decode_elapsed_s,
             prompt_tokens, completion_tokens, context_len, new_prefill_tokens,
             mtp_depth, drafted, accepted, accept_rate,
             drafted_by_depth, accepted_by_depth,
             bonus_tokens, correction_tokens, verify_calls,
             cache_source, session_cache_hit, cached_tokens, cache_restore_time_s,
             ssd_cache_hit, ssd_cached_tokens,
             draft_time_s, verify_forward_time_s, verify_eval_time_s, accept_time_s,
             client_label, model, reasoning_mode, tool_call_count, user_preview
           ) VALUES (
             ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,
             ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?, ?,
             ?, ?, ?, ?,  ?, ?, ?, ?, ?
           )`
        )
        .run(
          id,
          runId,
          ts,
          txt(rec.session_id),
          num(rec.decode_tok_s),
          num(rec.display_decode_tok_s),
          num(rec.prefill_tok_s),
          num(rec.prompt_tps),
          num(rec.ttft_s),
          num(rec.request_elapsed_s),
          num(rec.decode_elapsed_s),
          num(rec.prompt_tokens),
          num(rec.completion_tokens),
          num(rec.context_len),
          num(rec.new_prefill_tokens),
          num(rec.mtp_depth),
          drafted || null,
          accepted || null,
          acceptRate(rec),
          jsonArr(rec.drafted_by_depth),
          jsonArr(rec.accepted_by_depth),
          num(rec.bonus_tokens),
          num(rec.correction_tokens),
          num(rec.verify_calls),
          txt(rec.cache_source),
          flag(rec.session_cache_hit),
          num(rec.cached_tokens),
          num(rec.cache_restore_time_s),
          flag(rec.ssd_cache_hit),
          num(rec.ssd_cached_tokens),
          num(rec.draft_time_s),
          num(rec.verify_forward_time_s),
          num(rec.verify_eval_time_s),
          num(rec.accept_time_s),
          txt(rec.request_client_label),
          txt(rec.request_model),
          txt(rec.request_reasoning_mode),
          num(rec.tool_call_count),
          txt(rec.request_last_user_preview)
        );
    } catch (err) {
      this.fail('insertRequest', err);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "$(cat <<'EOF'
Persist one row per completed request

Stores numeric fields plus cheap attribution text (client label, model,
reasoning mode, user preview); no request bodies. accept_rate is
precomputed with the same expression sample() uses so live and stored
sparklines cannot drift. INSERT OR IGNORE preserves the original ts when
MTPLX's recent[] replays known requests after a dashboard restart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Gauges and bucketed range queries

**Files:**
- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: `Store` from Tasks 1–3.
- Produces:
  - `interface SeriesPoint { ts: number; avg: number | null; min: number | null; max: number | null; n: number }`
  - `interface SeriesResult { from: number; to: number; bucketMs: number; series: Record<string, SeriesPoint[]> }`
  - `Store.insertGauge(series: string, value: number | null, ts: number): void`
  - `Store.querySeries(names: string[], from: number, to: number, buckets: number): SeriesResult`
  - `Store.queryGauges(names: string[], from: number, to: number, buckets: number): SeriesResult`
  - `REQUEST_SERIES: Record<string, string>` — the closed allowlist mapping series name → SQL expression. Keys: `decode`, `prefill`, `ttft`, `accept`.

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts`:

```ts
import { REQUEST_SERIES } from './db';

test('querySeries buckets request rows and reports bucket starts', () => {
  const { store, cleanup } = tmpStore();
  const base = 1_700_000_000_000;
  // two requests in bucket 0, one in bucket 2, over a 4-bucket window
  store.insertRequest({ ...REC, request_id: 'a', display_decode_tok_s: 10 }, null, base + 100);
  store.insertRequest({ ...REC, request_id: 'b', display_decode_tok_s: 20 }, null, base + 200);
  store.insertRequest({ ...REC, request_id: 'c', display_decode_tok_s: 50 }, null, base + 2500);

  const res = store.querySeries(['decode'], base, base + 4000, 4);
  assert.equal(res.bucketMs, 1000);
  assert.deepEqual(res.series.decode, [
    { ts: base, avg: 15, min: 10, max: 20, n: 2 },
    { ts: base + 2000, avg: 50, min: 50, max: 50, n: 1 },
  ]);
  cleanup();
});

test('decode falls back to decode_tok_s when display is absent', () => {
  const { store, cleanup } = tmpStore();
  const base = 1_700_000_000_000;
  store.insertRequest(
    { ...REC, request_id: 'a', display_decode_tok_s: null, decode_tok_s: 7 },
    null,
    base + 10
  );
  const res = store.querySeries(['decode'], base, base + 1000, 1);
  assert.equal(res.series.decode[0].avg, 7);
  cleanup();
});

test('querySeries rejects names outside the allowlist', () => {
  const { store, cleanup } = tmpStore();
  assert.throws(() => store.querySeries(['ttft; DROP TABLE request'], 0, 1000, 1), /unknown series/i);
  /* Prototype-chain members must be rejected too: a bare REQUEST_SERIES[name]
     lookup returns a truthy inherited value for these, which would skip the
     throw and stringify a native function into the SQL. */
  for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => store.querySeries([evil], 0, 1000, 1), /unknown series/i);
  }
  /* A rejected name is a caller bug, not a storage failure — it must not run
     fail() and permanently pin status().ok to false for the process. */
  assert.equal(store.status().ok, true);
  assert.deepEqual(Object.keys(REQUEST_SERIES).sort(), ['accept', 'decode', 'prefill', 'ttft']);
  cleanup();
});

test('gauges round-trip through queryGauges', () => {
  const { store, cleanup } = tmpStore();
  const base = 1_700_000_000_000;
  store.insertGauge('session_bank_bytes', 100, base + 10);
  store.insertGauge('session_bank_bytes', 300, base + 20);
  store.insertGauge('active_requests', 1, base + 10);

  const res = store.queryGauges(['session_bank_bytes'], base, base + 1000, 1);
  assert.deepEqual(res.series.session_bank_bytes, [
    { ts: base, avg: 200, min: 100, max: 300, n: 2 },
  ]);
  cleanup();
});

test('an empty window yields an empty array, not an error', () => {
  const { store, cleanup } = tmpStore();
  const res = store.querySeries(['decode', 'ttft'], 0, 1000, 10);
  assert.deepEqual(res.series.decode, []);
  assert.deepEqual(res.series.ttft, []);
  cleanup();
});

test('a disabled store returns empty series', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: false,
    retentionDays: 30,
  });
  const res = store.querySeries(['decode'], 0, 1000, 10);
  assert.deepEqual(res.series.decode, []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.querySeries is not a function`.

- [ ] **Step 3: Implement gauges and bucketing**

In `server/db.ts`, add above `class SqliteStore`:

```ts
export interface SeriesPoint {
  /** Bucket start, ms. */
  ts: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

export interface SeriesResult {
  from: number;
  to: number;
  bucketMs: number;
  series: Record<string, SeriesPoint[]>;
}

/** Closed allowlist: series name → SQL expression over `request`. Names arrive
 *  from query strings, so nothing outside this map is ever interpolated. The
 *  COALESCE fallbacks mirror sample() in metricsPoller.ts exactly. */
export const REQUEST_SERIES: Record<string, string> = {
  decode: 'COALESCE(display_decode_tok_s, decode_tok_s)',
  prefill: 'COALESCE(prefill_tok_s, prompt_tps)',
  ttft: 'ttft_s',
  accept: 'accept_rate',
};
```

Add to the `Store` interface:

```ts
  insertGauge(series: string, value: number | null, ts: number): void;
  querySeries(names: string[], from: number, to: number, buckets: number): SeriesResult;
  queryGauges(names: string[], from: number, to: number, buckets: number): SeriesResult;
```

Add to `SqliteStore`:

```ts
  insertGauge(series: string, value: number | null, ts: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare('INSERT INTO gauge (ts, series, value) VALUES (?, ?, ?)')
        .run(ts, series, num(value));
    } catch (err) {
      this.fail('insertGauge', err);
    }
  }

  private bucketMs(from: number, to: number, buckets: number): number {
    return Math.max(1, Math.ceil((to - from) / Math.max(1, buckets)));
  }

  querySeries(names: string[], from: number, to: number, buckets: number): SeriesResult {
    const bucketMs = this.bucketMs(from, to, buckets);
    const series: Record<string, SeriesPoint[]> = {};
    for (const name of names) {
      /* Object.hasOwn, not a bare `REQUEST_SERIES[name]` lookup: a plain index
         resolves up the prototype chain, so names like 'constructor' or
         'toString' would return a truthy inherited value, skip this throw, and
         get stringified into the SQL below. */
      const expr = Object.hasOwn(REQUEST_SERIES, name) ? REQUEST_SERIES[name] : undefined;
      if (!expr) throw new Error(`unknown series: ${name}`);
      series[name] = this.bucketQuery(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                AVG(${expr}) AS avg, MIN(${expr}) AS min, MAX(${expr}) AS max,
                COUNT(${expr}) AS n
           FROM request
          WHERE ts >= ? AND ts < ? AND ${expr} IS NOT NULL
          GROUP BY b ORDER BY b`,
        [from, bucketMs, from, to],
        from,
        bucketMs
      );
    }
    return { from, to, bucketMs, series };
  }

  queryGauges(names: string[], from: number, to: number, buckets: number): SeriesResult {
    const bucketMs = this.bucketMs(from, to, buckets);
    const series: Record<string, SeriesPoint[]> = {};
    for (const name of names) {
      series[name] = this.bucketQuery(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(value) AS n
           FROM gauge
          WHERE series = ? AND ts >= ? AND ts < ? AND value IS NOT NULL
          GROUP BY b ORDER BY b`,
        [from, bucketMs, name, from, to],
        from,
        bucketMs
      );
    }
    return { from, to, bucketMs, series };
  }

  private bucketQuery(
    sql: string,
    params: (number | string)[],
    from: number,
    bucketMs: number
  ): SeriesPoint[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(sql).all(...params) as unknown as {
        b: number;
        avg: number | null;
        min: number | null;
        max: number | null;
        n: number;
      }[];
      return rows.map(r => ({
        ts: from + r.b * bucketMs,
        avg: r.avg,
        min: r.min,
        max: r.max,
        n: r.n,
      }));
    } catch (err) {
      this.fail('bucketQuery', err);
      return [];
    }
  }
```

Note that the allowlist check in `querySeries` happens **before** `bucketQuery`, and deliberately throws rather than degrading — an unknown series name is a caller bug, not a storage failure, and Task 8 turns it into a 400.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "$(cat <<'EOF'
Add gauge writes and bucketed range queries

querySeries/queryGauges group by CAST((ts - from) / bucketMs AS INTEGER)
so one query serves any range at any resolution. Series names resolve
through a closed allowlist; nothing from a query string reaches SQL.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Retention pruning

**Files:**
- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Interfaces:**
- Consumes: `Store` from Tasks 1–4.
- Produces:
  - `Store.prune(now: number): void` — deletes `request` and `gauge` rows older than `retentionDays`, and closed `run` rows whose `ended_at` precedes the cutoff. Never deletes the currently open run.

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts`:

```ts
const DAY = 86_400_000;

test('prune drops rows past the retention cutoff', () => {
  const { store, read, cleanup } = tmpStore(1); // 1-day retention
  const now = 1_700_000_000_000;
  store.insertRequest({ ...REC, request_id: 'old' }, null, now - 2 * DAY);
  store.insertRequest({ ...REC, request_id: 'new' }, null, now - 1000);
  store.insertGauge('active_requests', 1, now - 2 * DAY);
  store.insertGauge('active_requests', 2, now - 1000);

  store.prune(now);

  const ids = read(REQUESTS).map(r => r.request_id);
  assert.deepEqual(ids, ['new']);
  const g = store.queryGauges(['active_requests'], now - 3 * DAY, now + 1000, 1);
  assert.equal(g.series.active_requests[0].n, 1);
  cleanup();
});

test('prune keeps the open run but drops old closed runs', () => {
  const { store, read, cleanup } = tmpStore(1);
  const now = 1_700_000_000_000;
  const old = store.upsertRun(runInfo(1, now - 3 * DAY), now - 3 * DAY);
  /* The SECOND call's `now` is what stamps ended_at on the first run, so it
     must sit before the retention cutoff for that run to become prunable.
     Keeping startedAt and now equal here also keeps the pair coherent —
     detected_at can never precede started_at in production — and makes the
     surviving open run two days old, demonstrating that an open run is kept
     regardless of age. */
  const open = store.upsertRun(runInfo(2, now - 2 * DAY), now - 2 * DAY);
  assert.equal(read<RunRow>(RUNS).length, 2);

  store.prune(now);

  const ids = read<RunRow>(RUNS).map(r => r.id);
  assert.deepEqual(ids, [open]);
  assert.ok(!ids.includes(old as number));
  cleanup();
});

test('retentionDays of 0 prunes everything', () => {
  const { store, read, cleanup } = tmpStore(0);
  const now = 1_700_000_000_000;
  store.insertRequest({ ...REC, request_id: 'a' }, null, now - 1);
  store.prune(now);
  assert.equal(read(REQUESTS).length, 0);
  cleanup();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.prune is not a function`.

- [ ] **Step 3: Implement pruning**

Add to the `Store` interface in `server/db.ts`:

```ts
  prune(now: number): void;
```

Add to `SqliteStore`:

```ts
  prune(now: number): void {
    if (!this.db) return;
    const cutoff = now - this.options.retentionDays * 86_400_000;
    try {
      this.db.prepare('DELETE FROM request WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM gauge WHERE ts < ?').run(cutoff);
      /* Only closed runs are eligible — the open run must survive regardless of
         age, since live requests still reference it. */
      this.db.prepare('DELETE FROM run WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoff);
    } catch (err) {
      this.fail('prune', err);
    }
  }
```

No `VACUUM`: WAL reuses freed pages, and a blocking vacuum against a live database is not worth the reclaimed space for a local tool.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 21 tests.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "$(cat <<'EOF'
Add retention pruning for requests, gauges, and closed runs

The currently open run is never pruned regardless of age, since live
request rows still reference it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Health poller — run detection, gauges, and model ownership

**Files:**
- Create: `server/healthPoller.ts`
- Modify: `server/types.ts`
- Modify: `server/metricsPoller.ts:19-31,136-137,162-178,181-208` (remove `pollModelOnce`, accept the store)
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: `createStore`, `Store`, `RunInfo`, `PersistStatus` from Tasks 1–5.
- Produces:
  - `interface HealthResponse` in `types.ts` — the subset of `/health` this reads.
  - `healthPoller.start(store: Store): Promise<void>` — resolves after the first poll attempt (success or failure), so `server.ts` can order startup.
  - `healthPoller.stop(): void`
  - `healthPoller.getCurrentRunId(): number | null`
  - `healthPoller.getModel(): string | null`
  - `StatePayload.persist: PersistStatus`

- [ ] **Step 1: Add the health types**

In `server/types.ts`, add after `MtplxMetricsResponse`:

```ts
/** The subset of MTPLX's /health this server reads. The endpoint returns far
 *  more (env ablation flags, thermal, scheduler); the full body is archived
 *  verbatim on the `run` row rather than typed out here. */
export interface HealthResponse {
  model?: string | null;
  runtime_mode?: string | null;
  generation_mode?: string | null;
  depth?: number | null;
  verify_core?: string | null;
  paged_kv_quantization?: string | null;
  context_window?: number | null;
  active_requests?: number | null;
  requests_completed?: number | null;
  /** started_at is float SECONDS here, unlike every stored timestamp. */
  startup?: { pid?: number | null; started_at?: number | null };
  session_bank?: { max_entries?: number | null; max_bytes?: number | null; [k: string]: unknown };
  [key: string]: unknown;
}
```

Import `PersistStatus` at the top of `types.ts`:

```ts
import type { PersistStatus } from './db';
```

and add the field to `StatePayload`, after `logBufferSize`:

```ts
  persist: PersistStatus;
```

- [ ] **Step 2: Write the health poller**

Create `server/healthPoller.ts`:

```ts
import { config } from './config';
import type { Store, RunInfo } from './db';
import type { HealthResponse } from './types';

let store: Store | null = null;
let timer: NodeJS.Timeout | null = null;
let stopped = true;
let runId: number | null = null;
let model: string | null = null;
/** `${pid}:${started_at}` of the run currently believed live. */
let identity: string | null = null;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function txt(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toRunInfo(h: HealthResponse): RunInfo | null {
  const startedSec = num(h.startup?.started_at);
  if (startedSec === null) return null; // no identity available — cannot key a run
  return {
    pid: num(h.startup?.pid),
    startedAt: Math.round(startedSec * 1000), // float seconds → integer ms
    model: txt(h.model),
    runtimeMode: txt(h.runtime_mode),
    generationMode: txt(h.generation_mode),
    depth: num(h.depth),
    verifyCore: txt(h.verify_core),
    pagedKvQuantization: txt(h.paged_kv_quantization),
    contextWindow: num(h.context_window),
    health: JSON.stringify(h),
  };
}

async function pollOnce(): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${config.mtplxUrl}/health`, config.mtplxTimeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const h = (await res.json()) as HealthResponse;
    const now = Date.now();

    model = txt(h.model) ?? model;

    const info = toRunInfo(h);
    if (info && store) {
      const next = `${info.pid}:${info.startedAt}`;
      if (next !== identity || runId === null) {
        runId = store.upsertRun(info, now);
        identity = next;
      }
      store.insertGauge('active_requests', num(h.active_requests), now);
      store.insertGauge('requests_completed', num(h.requests_completed), now);
      store.insertGauge('session_bank_bytes', num(h.session_bank?.max_bytes), now);
      store.insertGauge('session_bank_entries', num(h.session_bank?.max_entries), now);
    }
  } catch {
    /* Leave runId/model at their last known values and retry on the fixed
       interval. This loop is already low-frequency, so it needs no backoff —
       unlike metricsPoller, whose cadence is 1s. */
  } finally {
    if (!stopped) timer = setTimeout(() => void pollOnce(), config.healthIntervalMs);
  }
}

/** Resolves after the FIRST poll attempt completes, so server.ts can guarantee
 *  a run exists (when MTPLX is up) before metricsPoller starts writing rows. */
export async function start(s: Store): Promise<void> {
  store = s;
  stopped = false;
  await pollOnce();
}

export function stop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}

export function getCurrentRunId(): number | null {
  return runId;
}

export function getModel(): string | null {
  return model;
}
```

- [ ] **Step 3: Remove `pollModelOnce` from `metricsPoller.ts`**

`/health` already returns the same `model` string `/v1/models` does, so the separate loop is redundant.

Delete the entire `pollModelOnce` function (`metricsPoller.ts:162-178`, the block introduced by the comment `/* Mirrors index.html's former fetchModel() ... */`).

Delete the module-level `model` and `modelTimer` declarations:

```ts
let model: string | null = null;
```
```ts
let modelTimer: NodeJS.Timeout | null = null;
```

In `start()`, delete the line `void pollModelOnce();`. In `stop()`, delete the line `if (modelTimer) clearTimeout(modelTimer);`.

At the top of the file, add:

```ts
import * as healthPoller from './healthPoller';
```

and in `getSnapshot()`, replace `model,` with:

```ts
    model: healthPoller.getModel(),
```

- [ ] **Step 4: Wire the store into `metricsPoller.start()` and the payload**

At the top of `server/metricsPoller.ts`, add to the type import list `Store` from `./db`:

```ts
import type { Store } from './db';
```

Add a module-level field next to the other state:

```ts
let store: Store | null = null;
```

Change the signature of `start()`:

```ts
export function start(s: Store): void {
  store = s;
  stopped = false;
  void pollOnce();
}
```

In `getSnapshot()`, add to the returned object after `logBufferSize`:

```ts
    persist: store
      ? store.status()
      : { enabled: false, ok: true, lastError: null },
```

- [ ] **Step 5: Order startup in `server.ts`**

Replace `server/server.ts` in full:

```ts
import express from 'express';
import path from 'node:path';
import { config } from './config';
import { createStore } from './db';
import * as poller from './metricsPoller';
import * as healthPoller from './healthPoller';
import * as sse from './sse';

const app = express();
const store = createStore({
  path: path.isAbsolute(config.dbPath)
    ? config.dbPath
    : path.join(__dirname, '..', config.dbPath),
  enabled: config.persistEnabled,
  retentionDays: config.retentionDays,
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/events', (req, res) => {
  sse.addClient(res);
  sse.sendSnapshot(res, poller.getSnapshot());
  req.on('close', () => sse.removeClient(res));
});

// Convenience/debug endpoint — plain JSON snapshot. Not required by either
// page's own code path since the SSE 'snapshot' event on connect already
// covers initial load.
app.get('/api/metrics', (_req, res) => {
  res.json(poller.getSnapshot());
});

const server = app.listen(config.port, () => {
  console.log(`mtplx-dashboard listening on :${config.port}, polling ${config.mtplxUrl}`);
});

let shuttingDown = false;

/* healthPoller first and awaited: its first poll establishes the run that
   metricsPoller tags every request row with, so there is no nullable-run
   window at boot. The shuttingDown guard matters because this chain is not
   cancellable — a signal arriving during that first in-flight /health poll
   would otherwise start the metrics poller after shutdown() had already run,
   arming a /metrics timer against a closed store. */
void healthPoller.start(store).then(() => {
  if (!shuttingDown) poller.start(store);
});

const heartbeat = sse.startHeartbeat();
const pruneTimer = setInterval(() => store.prune(Date.now()), config.pruneIntervalMs);
store.prune(Date.now()); // one prune at boot, so a long downtime is cleaned up immediately

function shutdown(): void {
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(pruneTimer);
  poller.stop();
  healthPoller.stop();
  store.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, 21 tests pass.

Start the server against live MTPLX and confirm a run row exists:

```bash
npm run dev
```

In another shell:

```bash
sqlite3 data/history.db "SELECT id, pid, datetime(started_at/1000,'unixepoch'), model, depth, runtime_mode FROM run;"
```

Expected: one row whose `pid` matches `curl -s http://127.0.0.1:8000/health | python3 -c "import json,sys; print(json.load(sys.stdin)['startup']['pid'])"`.

Confirm the model chip still populates by loading `http://127.0.0.1:8123/` — it must show a model name, proving the `/v1/models` removal did not regress it.

- [ ] **Step 7: Commit**

```bash
git add server/healthPoller.ts server/types.ts server/metricsPoller.ts server/server.ts
git commit -m "$(cat <<'EOF'
Add /health poller with run detection and gauge sampling

Detects MTPLX restarts exactly via startup.pid + startup.started_at and
writes run rows with the full health JSON. Takes over the model string
from /v1/models, letting pollModelOnce() and its separate timer go —
one fewer HTTP loop despite adding a feature.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Write request rows and tool-parse gauges from the metrics poller

**Files:**
- Modify: `server/metricsPoller.ts:69-88` (`ingestLog`), `:106-160` (`pollOnce`)

**Interfaces:**
- Consumes: `Store.insertRequest`, `Store.insertGauge` (Tasks 3–4); `healthPoller.getCurrentRunId()` (Task 6).
- Produces: no new exports. Side effect: every newly-seen `request_id` gets a `request` row; `tool_parse_*` gauges are written on change only.

- [ ] **Step 1: Persist request rows from `ingestLog`**

In `server/metricsPoller.ts`, replace the body of `ingestLog` with:

```ts
function ingestLog(recent: MetricsRecord[], now: number): string[] {
  const added: string[] = [];
  (recent || []).forEach(m => {
    const id = m.request_id;
    if (!id) return;
    const existing = logSeen.get(id);
    if (existing) {
      existing.data = m;
      return;
    }
    logSeen.set(id, { firstSeen: now, data: m });
    logOrder.unshift(id);
    added.push(id);
    /* First sight of this request_id — mirror it to SQLite with the same
       firstSeen stamp the in-memory buffer uses. */
    store?.insertRequest(m, healthPoller.getCurrentRunId(), now);
  });
  while (logOrder.length > config.logBufferSize) {
    const drop = logOrder.pop();
    if (drop) logSeen.delete(drop);
  }
  return added;
}
```

- [ ] **Step 2: Persist tool-parse gauges on change only**

The `tool_parse_*` values are cumulative counters that change rarely, so writing them every second would add ~86k rows/day of duplicates.

Add a module-level field next to the other state in `metricsPoller.ts`:

```ts
let lastToolParseSig: string | null = null;
```

Add this helper below `sig()`:

```ts
/** Cumulative tool-parse counters change rarely; this gates gauge writes so an
 *  idle server doesn't accumulate one identical row per second. */
const TOOL_PARSE_SERIES = [
  'tool_parse_success',
  'tool_parse_fallback',
  'unknown_tool_name',
  'malformed_tool_call',
  'unclosed_tool_call',
] as const;

function writeToolParseGauges(c: ToolParseCounters | null, now: number): void {
  if (!c || !store) return;
  const nextSig = TOOL_PARSE_SERIES.map(k => c[k] ?? '').join('|');
  if (nextSig === lastToolParseSig) return;
  lastToolParseSig = nextSig;
  for (const k of TOOL_PARSE_SERIES) {
    const v = c[k];
    store.insertGauge(k, typeof v === 'number' ? v : null, now);
  }
}
```

In `pollOnce()`, immediately after the line `toolParseCounters = data.tool_parse_counters ?? toolParseCounters;`, add:

```ts
    writeToolParseGauges(toolParseCounters, now);
```

- [ ] **Step 2b: Verify request rows land**

Run: `npm run typecheck && npm run dev`, then drive at least one request through MTPLX and check:

```bash
sqlite3 data/history.db "SELECT request_id, run_id, datetime(ts/1000,'unixepoch'), prompt_tokens, round(accept_rate,3), client_label FROM request ORDER BY ts DESC LIMIT 5;"
```

Expected: rows with a non-null `run_id`, a plausible `ts`, and `accept_rate` between 0 and 1.

Check the gauges are not duplicating per second:

```bash
sqlite3 data/history.db "SELECT series, COUNT(*) FROM gauge GROUP BY series;"
```

Expected: `active_requests` / `requests_completed` / `session_bank_*` grow at roughly one row per 5s each; the `tool_parse_*` counts stay far lower.

- [ ] **Step 3: Commit**

```bash
git add server/metricsPoller.ts
git commit -m "$(cat <<'EOF'
Mirror newly-seen requests and tool-parse counters to SQLite

Request rows are written from ingestLog() with the same firstSeen stamp
the in-memory buffer uses. Tool-parse gauges are gated on a change
signature so an idle server doesn't write identical rows every second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: History API endpoints

**Files:**
- Modify: `server/server.ts`

**Interfaces:**
- Consumes: `Store.querySeries`, `Store.queryGauges`, `REQUEST_SERIES` (Task 4).
- Produces:
  - `GET /api/history/series?names=decode,prefill,ttft,accept&from=<ms>&to=<ms>&buckets=<n>` → `SeriesResult` JSON.
  - `GET /api/history/gauges?names=<a,b>&from=<ms>&to=<ms>&buckets=<n>` → `SeriesResult` JSON.
  - Both default `to` to now, `from` to `to - 3600000`, `buckets` to 240 (clamped 1–2000). Unknown request-series names → HTTP 400.

- [ ] **Step 1: Add the endpoints**

In `server/server.ts`, add the import:

```ts
import { createStore, REQUEST_SERIES } from './db';
```

and insert these routes after the `/api/metrics` handler:

```ts
/** Parses the shared from/to/buckets/names query shape. `buckets` is clamped
 *  because it sizes the GROUP BY output the client has to render. */
function parseRange(q: Record<string, unknown>, fallbackNames: string[]) {
  const int = (v: unknown, def: number): number => {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : def;
  };
  const to = int(q.to, Date.now());
  const from = int(q.from, to - 3600000);
  const buckets = Math.min(2000, Math.max(1, int(q.buckets, 240)));
  const raw = typeof q.names === 'string' ? q.names : '';
  const names = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : fallbackNames;
  return { from, to, buckets, names };
}

app.get('/api/history/series', (req, res) => {
  const { from, to, buckets, names } = parseRange(
    req.query as Record<string, unknown>,
    Object.keys(REQUEST_SERIES)
  );
  /* Object.hasOwn, not `n in REQUEST_SERIES`: the `in` operator walks the
     prototype chain, so 'constructor'/'toString'/'__proto__' would pass this
     filter, reach querySeries, and be rejected there by its own Object.hasOwn
     guard — but as an unhandled throw escaping Express as a 500 instead of the
     400 this endpoint is supposed to return. */
  const unknown = names.filter(n => !Object.hasOwn(REQUEST_SERIES, n));
  if (unknown.length) {
    res.status(400).json({
      error: `unknown series: ${unknown.join(', ')}`,
      known: Object.keys(REQUEST_SERIES),
    });
    return;
  }
  res.json(store.querySeries(names, from, to, buckets));
});

app.get('/api/history/gauges', (req, res) => {
  const { from, to, buckets, names } = parseRange(req.query as Record<string, unknown>, []);
  res.json(store.queryGauges(names, from, to, buckets));
});
```

Gauge names are not allowlisted because they are bound as a SQL parameter (`WHERE series = ?`), never interpolated — an unknown name simply returns an empty array.

- [ ] **Step 2: Verify the endpoints**

Run: `npm run typecheck && npm run dev`, then:

```bash
curl -s "http://127.0.0.1:8123/api/history/series?names=decode,ttft&buckets=6" | python3 -m json.tool | head -30
```

Expected: `bucketMs` ≈ 600000 for the default 1h window, and `series.decode` / `series.ttft` arrays of `{ts, avg, min, max, n}`.

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8123/api/history/series?names=bogus"
```

Expected: `400`.

- [ ] **Step 3: Cross-check stored against live**

This is the check that proves the writer correct: the stored series and the in-memory ring must agree, since both use the same `accept_rate` expression.

```bash
curl -s "http://127.0.0.1:8123/api/metrics" | python3 -c "
import json,sys
p = json.load(sys.stdin)
r = [v for v in p['rings']['decode'] if v is not None]
print('live ring decode, last 5:', [round(v,2) for v in r[-5:]])
"
curl -s "http://127.0.0.1:8123/api/history/series?names=decode&buckets=2000" | python3 -c "
import json,sys
s = json.load(sys.stdin)['series']['decode']
print('stored decode, last 5 :', [round(p['avg'],2) for p in s[-5:]])
"
```

Expected: the trailing values match (buckets narrow enough that `n == 1` per bucket makes `avg` the raw sample). A mismatch means the field mapping in Task 3 is wrong — stop and fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add server/server.ts
git commit -m "$(cat <<'EOF'
Add GET /api/history/series and /api/history/gauges

Both take from/to/buckets and return bucketed {ts, avg, min, max, n}.
Request-series names resolve through the closed allowlist and 400 on
anything unknown; gauge names bind as SQL parameters.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Range selector on the dashboard

**Files:**
- Modify: `public/index.html:259-265` (header), `:384-399` (state), `:517-521` (spark construction), `:710-752` (payload + resize)

**Interfaces:**
- Consumes: `GET /api/history/series` (Task 8).
- Produces: no exports. Behavioural contract: when the range is `live`, sparklines render `p.rings` exactly as today; for any other range they render bucketed averages fetched from the API and refresh every 30s.

**Note on convention:** per `CLAUDE.md`, rendering code stays hand-duplicated across `public/*.html`. This task touches `index.html` only; `log.html` and `detail.html` are untouched.

- [ ] **Step 1: Add the selector markup and styles**

In `public/index.html`, inside `<div class="head-right">` (line 259), insert as the first child, before the `status-pill` span:

```html
      <span class="range-sel" id="range-sel">
        <button type="button" data-range="live" class="active">live</button>
        <button type="button" data-range="3600000">1h</button>
        <button type="button" data-range="86400000">24h</button>
        <button type="button" data-range="604800000">7d</button>
      </span>
      <span class="sep">·</span>
```

Add these rules next to the existing `.spark-cap` rule (line 211):

```css
.range-sel { display: inline-flex; gap: 2px; border: 1px solid var(--line); border-radius: 6px; padding: 2px; }
.range-sel button {
  font: inherit; font-size: 11px; line-height: 1; padding: 4px 7px; cursor: pointer;
  background: transparent; color: var(--muted); border: 0; border-radius: 4px;
}
.range-sel button:hover { color: var(--ink-2); }
.range-sel button.active { background: var(--s1); color: #fff; }
```

- [ ] **Step 2: Add the range state and fetch**

In the state block (after line 398, `let connected = false;`), add:

```js
/* null = live (render the server's in-memory rings); a number = window width in
   ms, rendered from bucketed history via /api/history/series. */
let rangeMs = null;
let historyRings = { decode: [], prefill: [], ttft: [], accept: [] };
let historyTimer = null;
let historyGen = 0; // invalidates in-flight loadHistory() responses on range change
```

Add these functions immediately before `applyPayload` (line 710):

```js
/* ================================================================= history
   For non-live ranges the sparklines render bucketed averages from SQLite
   instead of the server's in-memory ring. Same spark widgets, same formatters
   — only the array they're handed changes. */
async function loadHistory() {
  if (rangeMs === null) return;
  /* Generation token: two range clicks in quick succession leave two fetches in
     flight, and they can resolve out of order — painting 1h data under a
     highlighted 24h button, silently. A stale response drops instead. The guard
     covers the error path too, or a stale failure would blank the current
     range's sparklines. */
  const gen = ++historyGen;
  const to = Date.now(), from = to - rangeMs;
  try {
    const r = await fetch(
      `/api/history/series?names=decode,prefill,ttft,accept&from=${from}&to=${to}&buckets=${CTX_BUCKETS}`
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (gen !== historyGen) return;
    historyRings = {
      decode:  (j.series.decode  || []).map(p => p.avg),
      prefill: (j.series.prefill || []).map(p => p.avg),
      ttft:    (j.series.ttft    || []).map(p => p.avg),
      accept:  (j.series.accept  || []).map(p => p.avg),
    };
  } catch {
    if (gen !== historyGen) return;
    historyRings = { decode: [], prefill: [], ttft: [], accept: [] };
  }
  renderSparks();
}

/* The one place that decides which array the sparklines see. */
function activeRings() {
  return rangeMs === null ? rings : historyRings;
}

function renderSparks() {
  const r = activeRings();
  sparks.decode.render(r.decode);
  sparks.prefill.render(r.prefill);
  sparks.ttft.render(r.ttft);
  sparks.accept.render(r.accept);
  const vals = r.accept.filter(v => v != null);
  $('spark-accept-cap').textContent = vals.length
    ? fmt((vals.reduce((a, b) => a + b, 0) / vals.length) * 100, 1) + '% mean over ' +
      vals.length + (rangeMs === null ? ' requests' : ' buckets')
    : '—';
}

function setRange(value) {
  rangeMs = value === 'live' ? null : Number(value);
  for (const b of $('range-sel').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.range === value);
  }
  clearInterval(historyTimer);
  historyTimer = null;
  if (rangeMs === null) {
    renderSparks();
  } else {
    loadHistory();
    historyTimer = setInterval(loadHistory, 30000);
  }
}

$('range-sel').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setRange(b.dataset.range);
});
```

Add the bucket-count constant next to `CTX_MAX` (line 390):

```js
const CTX_BUCKETS = 240; // spark resolution for non-live ranges
```

- [ ] **Step 3: Route the existing renderers through `renderSparks`**

In `renderHero` (line 573), delete these lines:

```js
  sparks.accept.render(rings.accept);
```

and the `spark-accept-cap` block immediately following it (lines 574-578), since `renderSparks()` now owns both.

In `renderThroughput` (line 584), delete:

```js
  sparks.decode.render(rings.decode);
  sparks.prefill.render(rings.prefill);
```

In `renderLatency` (line 592), delete:

```js
  sparks.ttft.render(rings.ttft);
```

In `applyPayload`, add a call at the end, after `renderStatus();`:

```js
  renderSparks();
```

Replace the resize handler body (lines 746-751) with:

```js
  rz = setTimeout(renderSparks, 150);
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev` and open `http://127.0.0.1:8123/`.

Check each of these:
1. Default state is `live` and the sparklines behave exactly as before.
2. Clicking `1h` repaints all four sparklines from history; the acceptance caption switches from "requests" to "buckets".
3. Clicking back to `live` restores the ring-driven sparks immediately.
4. With `24h` selected, an incoming request does **not** yank the sparks back to live data.
5. Resizing the window redraws whichever range is selected, not always the live one.
6. Dark mode still renders the selector legibly (toggle the OS appearance).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
Add live/1h/24h/7d range selector to the dashboard sparklines

Non-live ranges render bucketed averages from /api/history/series and
refresh every 30s; live keeps rendering the server's in-memory ring.
renderSparks() becomes the single place that decides which array the
spark widgets see.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: no code.

- [ ] **Step 1: Document the new env vars**

Add to `.env.example`:

```
# SQLite stats persistence
DB_PATH=data/history.db
PERSIST_ENABLED=1
RETENTION_DAYS=30
PRUNE_INTERVAL_MS=3600000
HEALTH_INTERVAL_MS=5000
```

Add the same five rows to the README's env var table, with these descriptions:

| var | default | meaning |
|---|---|---|
| `DB_PATH` | `data/history.db` | SQLite history file. Relative paths resolve against the repo root. |
| `PERSIST_ENABLED` | `1` | `0` disables all persistence; the dashboard runs live-only. |
| `RETENTION_DAYS` | `30` | Rows older than this are pruned. |
| `PRUNE_INTERVAL_MS` | `3600000` | How often the prune runs. |
| `HEALTH_INTERVAL_MS` | `5000` | `/health` poll cadence; also drives the model chip. |

Also note in the README that Node `>=22.5` is now required (for `node:sqlite`) and that `npm test` runs the `db.ts` unit tests.

- [ ] **Step 2: Update `CLAUDE.md`**

In the **Server (`server/`)** list, add two entries:

```
- `db.ts` — all SQLite I/O behind a `Store` created by `createStore()`. Owns the v1 schema
  (`run`/`request`/`gauge`), prepared statements, bucketed range queries, and the prune. Every
  method catches its own errors and degrades rather than throwing — persistence must never be
  able to break the live dashboard. Injected into the pollers by `server.ts`, not a global.
- `healthPoller.ts` — low-frequency `/health` loop. Detects MTPLX restarts exactly via
  `startup.pid` + `startup.started_at`, writes `run` rows with the full health JSON, samples the
  request-less gauges, and owns the model string (which is why `metricsPoller` no longer polls
  `/v1/models`).
```

Add a new section after **Server-side history buffers**:

```
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

In **Running / testing**, replace "No automated test suite" with:

```
`npm test` runs `node:test` unit tests for `server/db.ts` against an in-memory SQLite database.
Everything else is still verified by loading the pages against a real MTPLX — there is no
frontend test harness.
```

- [ ] **Step 2b: Full end-to-end verification**

Work through the spec's verification list:

1. `npm run typecheck && npm test` — clean, 21 tests pass.
2. `npm run dev`, drive traffic, confirm `request`, `gauge`, and `run` rows accumulate.
3. Cross-check live vs stored (the commands in Task 8, Step 3) — trailing values must match.
4. Restart MTPLX, then:
   ```bash
   sqlite3 data/history.db "SELECT id, pid, ended_at FROM run ORDER BY id;"
   ```
   Expected: a second row, and the first row's `ended_at` set.
5. Restart the dashboard while MTPLX keeps running; confirm no duplicate-key errors in the log and:
   ```bash
   sqlite3 data/history.db "SELECT COUNT(*), COUNT(DISTINCT request_id) FROM request;"
   ```
   Expected: the two counts are equal.
6. `RETENTION_DAYS=0 npm run dev` — confirm `SELECT COUNT(*) FROM request;` goes to 0 at boot.
7. `PERSIST_ENABLED=0 npm run dev` — dashboard behaves as before; `/api/history/series` returns empty arrays; no `data/` writes.
8. `DB_PATH=/nonexistent-dir-xyz/history.db npm run dev` — the dashboard still serves live data, one `[db] open failed` line appears, and `/api/metrics` shows `persist.ok === false`.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md .env.example
git commit -m "$(cat <<'EOF'
Document SQLite persistence, new env vars, and the Node 22.5 floor

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Out of scope (Phase 2)

Deliberately not in this plan, per the spec:

- `public/history.html` — run table, config diff between runs, gauge charts, restart markers.
- `GET /api/history/runs` and `GET /api/history/runs/:id`.
- Surfacing `persist.ok === false` visually in the page chrome. The field is in `StatePayload` from Task 6 and readable via `/api/metrics`, but no page renders it yet.

## Known limitation carried from the spec

Requests that complete while the dashboard is **down** get an approximate `ts` (first-sight time, not completion time) if they are still in MTPLX's `recent[]` window when the dashboard restarts. `/metrics` exposes no completion timestamp, so this is not fixable here; the error is bounded by MTPLX's 32-record window.
