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
