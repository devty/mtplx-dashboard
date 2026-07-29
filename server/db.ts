import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { MetricsRecord } from './types';

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

/** Every method here has a production caller. Test-only introspection belongs
 *  in the test file's own read connection, not on this interface. */
export interface Store {
  status(): PersistStatus;
  upsertRun(info: RunInfo, now: number): number | null;
  currentRunId(): number | null;
  insertRequest(rec: MetricsRecord, runId: number | null, ts: number): void;
  insertGauge(series: string, value: number | null, ts: number): void;
  querySeries(names: string[], from: number, to: number, buckets: number): SeriesResult;
  queryGauges(names: string[], from: number, to: number, buckets: number): SeriesResult;
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

class SqliteStore implements Store {
  private db: DatabaseSync | null = null;
  private ok = true;
  private lastError: string | null = null;
  /** Failure classes already logged, so a full disk logs once, not per row. */
  private loggedClasses = new Set<string>();
  private runId: number | null = null;

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
      const expr = REQUEST_SERIES[name];
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
