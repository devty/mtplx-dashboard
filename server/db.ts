import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { DreamRunRecord } from './dreamParse';

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

/** Governs only the TOLERANT (nearest-match) path in upsertRun — the one
 *  gated on `opts.adopt` — for two derived origins that are close but not
 *  identical. An exact `(target_id, started_at)` repeat is same-run identity,
 *  not an inference, and is handled unconditionally before this tolerance is
 *  ever consulted (see upsertRun).
 *
 *  `started_at` is derived as `now - uptime * 1000` from independently sampled
 *  values, so it wanders by milliseconds between observations and by more
 *  across a dashboard restart, where the derivation starts over. Without this
 *  tolerance, that wander would mint a spurious new run every time the
 *  DASHBOARD (not the target) restarts, even though the target process never
 *  did.
 *
 *  Distance alone is NOT sufficient evidence of sameness: in a crash loop each
 *  short-lived process starts within this window of the last, so an
 *  unconditional tolerant match would merge N real restarts into one
 *  never-closed run and hide the instability the run table exists to show.
 *  That is why adoption is gated on the caller's first observation rather than
 *  on the window alone. */
export const RUN_IDENTITY_TOLERANCE_MS = 30_000;

export interface StoreOptions {
  /** SQLite file path. Its parent directory is created if missing. */
  path: string;
  enabled: boolean;
  retentionDays: number;
  /** Bodies age out ahead of metrics — see spec section 5.3. */
  transcriptRetentionDays: number;
}

export interface PersistStatus {
  enabled: boolean;
  ok: boolean;
  lastError: string | null;
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

export interface RunRow {
  id: number;
  target_id: string;
  started_at: number;
  detected_at: number;
  ended_at: number | null;
  model: string | null;
  version: string | null;
  kv_cache_dtype: string | null;
  turboquant_mode: string | null;
  spec_decode_method: string | null;
  engine_type: string | null;
  context_window: number | null;
  health: string;
}

export interface RunAggregate {
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface RunSummary {
  id: number;
  targetId: string;
  startedAt: number;
  endedAt: number | null;
  model: string | null;
  version: string | null;
  kvCacheDtype: string | null;
  turboquantMode: string | null;
  specDecodeMethod: string | null;
  engineType: string | null;
  contextWindow: number | null;
  requestCount: number;
  decode: RunAggregate;
  ttft: RunAggregate;
}

export interface RunDetail {
  id: number;
  targetId: string;
  startedAt: number;
  detectedAt: number;
  endedAt: number | null;
  model: string | null;
  version: string | null;
  kvCacheDtype: string | null;
  turboquantMode: string | null;
  specDecodeMethod: string | null;
  engineType: string | null;
  contextWindow: number | null;
  health: string;
}

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

/** Every method here has a production caller. Test-only introspection belongs
 *  in the test file's own read connection, not on this interface. */
export interface Store {
  status(): PersistStatus;
  upsertRun(info: RunInfo, now: number, opts?: { adopt?: boolean }): number | null;
  queryRuns(limit: number): RunSummary[];
  getRun(id: number): RunDetail | null;
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
  prune(now: number): void;
  insertDreamRun(run: DreamRunRecord, commitFromGit: string | null, commitSource: DreamCommitSource): number | null;
  queryDreamNights(limit: number): DreamNightRow[];
  getDreamNight(date: string): DreamNightDetail | null;
  upsertDreamNight(date: string, expectedAt: number, runId: number | null, status: DreamNightStatus): void;
  /** Writes a night row only when that date has none. Used for slots derived
   *  OUTSIDE the evidence a pass actually parsed, so a later pass can never
   *  overwrite a verdict an earlier one established. */
  insertDreamNightIfAbsent(date: string, expectedAt: number, status: DreamNightStatus): void;
  latestDreamNight(): { date: string; expectedAt: number } | null;
  dreamIngestOffset(): number;
  setDreamIngestOffset(offset: number): void;
  close(): void;
}

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

/** Flat shape node:sqlite returns for the queryRuns() join — mapped to the
 *  nested RunSummary the API/UI actually want. */
interface RawRunSummaryRow {
  id: number;
  target_id: string;
  started_at: number;
  ended_at: number | null;
  model: string | null;
  version: string | null;
  kv_cache_dtype: string | null;
  turboquant_mode: string | null;
  spec_decode_method: string | null;
  engine_type: string | null;
  context_window: number | null;
  request_count: number;
  decode_avg: number | null;
  decode_min: number | null;
  decode_max: number | null;
  ttft_avg: number | null;
  ttft_min: number | null;
  ttft_max: number | null;
}

function toRunSummary(r: RawRunSummaryRow): RunSummary {
  return {
    id: r.id,
    targetId: r.target_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    model: r.model,
    version: r.version,
    kvCacheDtype: r.kv_cache_dtype,
    turboquantMode: r.turboquant_mode,
    specDecodeMethod: r.spec_decode_method,
    engineType: r.engine_type,
    contextWindow: r.context_window,
    requestCount: r.request_count,
    decode: { avg: r.decode_avg, min: r.decode_min, max: r.decode_max },
    ttft: { avg: r.ttft_avg, min: r.ttft_min, max: r.ttft_max },
  };
}

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

    const version = this.readUserVersionFromHeader(file);
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
    /* The archive name records which schema wrote it, not which product — v1
       was MTPLX-era but v2 is already rapid-mlx, so a hardcoded -mtplx suffix
       would mislabel every future set-aside. */
    const taken = (p: string): boolean =>
      fs.existsSync(p) || fs.existsSync(p + '-wal') || fs.existsSync(p + '-shm');
    let aside = `${base}-v${version}.db`;
    for (let n = 2; taken(aside); n++) aside = `${base}-v${version}.${n}.db`;
    fs.renameSync(file, aside);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, aside + suffix);
    }
    console.warn(`[db] schema v${version} found, expected v${SCHEMA_VERSION}; moved aside to ${aside}`);
  }

  /** Reads PRAGMA user_version straight out of the SQLite file header (a
   *  big-endian uint32 at byte offset 60 — see the SQLite file format spec)
   *  instead of opening a DatabaseSync connection to run the pragma.
   *
   *  This matters because a stale/corrupt -wal or -shm can sit next to `file`
   *  (that is exactly the case setAsideIfStale exists to handle). Opening any
   *  connection — even one made with `{ readOnly: true }` — makes SQLite's
   *  WAL-index code memory-map and, if the -shm content doesn't check out,
   *  rebuild it. That mapping is backed by the file's inode, not its path: it
   *  can keep landing writes on that inode after this method has already
   *  called fs.renameSync on it, silently reintroducing real WAL-index bytes
   *  into what is supposed to be an untouched archived sidecar. Parsing the
   *  header by hand never maps or opens the file for SQLite, so nothing can
   *  write to it before the rename. Returns 0 (treated as "not our schema,
   *  but also not a version to trust") for anything that isn't a well-formed
   *  SQLite file, which lets the normal open path surface the real error. */
  private readUserVersionFromHeader(file: string): number {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const header = Buffer.alloc(16);
        if (fs.readSync(fd, header, 0, 16, 0) < 16) return 0;
        if (header.toString('utf8', 0, 15) !== 'SQLite format 3') return 0;
        const versionBytes = Buffer.alloc(4);
        if (fs.readSync(fd, versionBytes, 0, 4, 60) < 4) return 0;
        return versionBytes.readUInt32BE(0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 0;
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

  upsertRun(info: RunInfo, now: number, opts: { adopt?: boolean } = {}): number | null {
    if (!this.db) return null;
    try {
      /* Exact origin means the same run — identity, not inference — so this
         holds regardless of `adopt`. Without it a benign repeat would hit the
         UNIQUE index, and fail() would report degraded persistence to the user
         for something entirely harmless. */
      const exact = this.db
        .prepare('SELECT id FROM run WHERE target_id = ? AND started_at = ?')
        .get(info.targetId, info.startedAt) as { id: number } | undefined;
      if (exact) return exact.id;

      /* Adopt the nearest run whose origin is within tolerance rather than
         requiring an exact match — see RUN_IDENTITY_TOLERANCE_MS. Only when
         the caller has told us this is a first observation of an unchanged
         process; otherwise (a detected restart) distance alone is not
         evidence of sameness — see the tolerance comment above. */
      if (opts.adopt) {
        const existing = this.db
          .prepare(
            `SELECT id FROM run
              WHERE target_id = ? AND ABS(started_at - ?) <= ?
              ORDER BY ABS(started_at - ?) LIMIT 1`
          )
          .get(info.targetId, info.startedAt, RUN_IDENTITY_TOLERANCE_MS, info.startedAt) as
          | { id: number }
          | undefined;

        if (existing) {
          /* The process is demonstrably still running, so clear any ended_at a
             previous false-restart stamped on it. */
          this.db.prepare('UPDATE run SET ended_at = NULL WHERE id = ?').run(existing.id);
          return existing.id;
        }
      }

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

  queryRuns(limit: number): RunSummary[] {
    if (!this.db) return [];
    try {
      const decode = REQUEST_SERIES.decode;
      const rows = this.db
        .prepare(
          `SELECT
             run.id, run.target_id, run.started_at, run.ended_at, run.model,
             run.version, run.kv_cache_dtype, run.turboquant_mode, run.spec_decode_method,
             run.engine_type, run.context_window,
             COUNT(request.request_id) AS request_count,
             AVG(${decode}) AS decode_avg, MIN(${decode}) AS decode_min, MAX(${decode}) AS decode_max,
             AVG(request.ttft_s) AS ttft_avg, MIN(request.ttft_s) AS ttft_min, MAX(request.ttft_s) AS ttft_max
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
        targetId: row.target_id,
        startedAt: row.started_at,
        detectedAt: row.detected_at,
        endedAt: row.ended_at,
        model: row.model,
        version: row.version,
        kvCacheDtype: row.kv_cache_dtype,
        turboquantMode: row.turboquant_mode,
        specDecodeMethod: row.spec_decode_method,
        engineType: row.engine_type,
        contextWindow: row.context_window,
        health: row.health,
      };
    } catch (err) {
      this.fail('getRun', err);
      return null;
    }
  }

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

  insertGauge(targetId: string, series: string, value: number | null, ts: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare('INSERT INTO gauge (ts, target_id, series, value) VALUES (?, ?, ?, ?)')
        .run(ts, targetId, series, num(value));
    } catch (err) {
      this.fail('insertGauge', err);
    }
  }

  private bucketMs(from: number, to: number, buckets: number): number {
    return Math.max(1, Math.ceil((to - from) / Math.max(1, buckets)));
  }

  querySeries(targetId: string, names: string[], from: number, to: number, buckets: number): SeriesResult {
    const bucketMs = this.bucketMs(from, to, buckets);
    const series: Record<string, SeriesPoint[]> = {};
    for (const name of names) {
      const expr = Object.hasOwn(REQUEST_SERIES, name) ? REQUEST_SERIES[name] : undefined;
      if (!expr) throw new Error(`unknown series: ${name}`);
      series[name] = this.bucketQuery(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                AVG(${expr}) AS avg, MIN(${expr}) AS min, MAX(${expr}) AS max,
                COUNT(${expr}) AS n
           FROM request
          WHERE target_id = ? AND ts >= ? AND ts < ? AND ${expr} IS NOT NULL
          GROUP BY b ORDER BY b`,
        [from, bucketMs, targetId, from, to],
        from,
        bucketMs
      );
    }
    return { from, to, bucketMs, series };
  }

  queryGauges(targetId: string, names: string[], from: number, to: number, buckets: number): SeriesResult {
    const bucketMs = this.bucketMs(from, to, buckets);
    const series: Record<string, SeriesPoint[]> = {};
    for (const name of names) {
      series[name] = this.bucketQuery(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(value) AS n
           FROM gauge
          WHERE target_id = ? AND series = ? AND ts >= ? AND ts < ? AND value IS NOT NULL
          GROUP BY b ORDER BY b`,
        [from, bucketMs, targetId, name, from, to],
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

  insertDreamRun(
    run: DreamRunRecord,
    commitFromGit: string | null,
    commitSource: DreamCommitSource
  ): number | null {
    if (!this.db) return null;
    try {
      /* `default` is the usual committer but not the only one: a night where
         only another source committed still banked work, and reading only
         `default` stored commit_source='log' beside a NULL sha — which silences
         the "banked work despite not finishing" callout on exactly the nights
         that callout exists for. Insertion order, so: first source that
         committed. */
      const shaFromLog =
        run.committedShas.get('default') ?? run.committedShas.values().next().value ?? null;
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

  insertDreamNightIfAbsent(date: string, expectedAt: number, status: DreamNightStatus): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO dream_night (date, expected_at, run_id, status)
           VALUES (?, ?, NULL, ?)
           ON CONFLICT(date) DO NOTHING`
        )
        .run(date, expectedAt, status);
    } catch (err) {
      this.fail('insertDreamNightIfAbsent', err);
    }
  }

  latestDreamNight(): { date: string; expectedAt: number } | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare('SELECT date, expected_at AS expectedAt FROM dream_night ORDER BY date DESC LIMIT 1')
        .get() as { date: string; expectedAt: number } | undefined;
      return row ?? null;
    } catch (err) {
      this.fail('latestDreamNight', err);
      return null;
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
        .all(limit) as unknown as DreamNightRow[];
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
            .all(night.runId) as unknown as DreamPhaseRow[])
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
