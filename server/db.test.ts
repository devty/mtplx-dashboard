import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SCHEMA_VERSION, REQUEST_SERIES, RUN_IDENTITY_TOLERANCE_MS } from './db';
import type { RunInfo, RunRow, RunDetail, RequestRow } from './db';
import { parseDreamLog } from './dreamParse';
import { attributeRun } from './dreamAttribute';

const DAY = 86_400_000;

/** Creates a Store backed by a throwaway file, plus an independent read
 *  connection for assertions. A second connection is why this uses a temp file
 *  rather than ':memory:' — an in-memory database is private to the connection
 *  that opened it, so a reader would see an empty schema. WAL lets both
 *  connections coexist. `read` opens read-write because a strictly read-only
 *  connection cannot create the -shm file WAL needs. */
function tmpStore(retentionDays = 30, transcriptRetentionDays = 7) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');
  const store = createStore({
    path: file,
    enabled: true,
    retentionDays,
    transcriptRetentionDays,
  });
  /* node:sqlite's .all() returns null-prototype row objects; this file imports
     'node:assert/strict', where deepEqual is deepStrictEqual, which fails on a
     prototype mismatch alone even when every field matches. Spreading into a
     plain object strips the null prototype without touching the values. */
  const read = <T = Record<string, unknown>>(sql: string): T[] => {
    const db = new DatabaseSync(file);
    try {
      return (db.prepare(sql).all() as unknown as Record<string, unknown>[]).map(
        r => ({ ...r })
      ) as T[];
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

function runInfo(targetId: string, startedAt: number, over: Partial<RunInfo> = {}): RunInfo {
  return {
    targetId,
    startedAt,
    model: 'test-model',
    version: '1.0.0',
    kvCacheDtype: 'bf16',
    turboquantMode: 'off',
    specDecodeMethod: 'none',
    engineType: 'mlx',
    contextWindow: 98304,
    health: JSON.stringify({ ok: true }),
    ...over,
  };
}

const RUNS = 'SELECT * FROM run ORDER BY id';
const REQUESTS = 'SELECT * FROM request ORDER BY ts';

const REQ: RequestRow = {
  requestId: 'req-1',
  targetId: 'qwen',
  runId: null,
  ts: 1_700_000_002_000,
  model: 'rapid-mlx-qwen3',
  promptTokens: 436,
  completionTokens: 9,
  ttftS: 1.06,
  requestElapsedS: 1.26,
  decodeTokS: 43.8,
  clientLabel: 'opencode',
  toolCallCount: 0,
  userPreview: 'hello there',
  outcome: 'ok',
  statusCode: 200,
  streamed: true,
  finishReason: 'stop',
  engineJoined: true,
};

/* ---------------------------------------------------------------------- */
/* Schema / versioning                                                    */
/* ---------------------------------------------------------------------- */

test('creates the schema successfully', () => {
  const { store, cleanup } = tmpStore();
  assert.equal(store.status().enabled, true);
  assert.equal(store.status().ok, true);
  assert.equal(store.status().lastError, null);
  cleanup();
});

test('v3 schema has the transcript and dream tables', () => {
  const { read, cleanup } = tmpStore();
  const tables = read<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).map(r => r.name);
  assert.deepEqual(tables, [
    'dream_ingest',
    'dream_night',
    'dream_phase',
    'dream_run',
    'dream_source_cycle',
    'gauge',
    'request',
    'run',
    'transcript',
  ]);
  const [{ user_version }] = read<{ user_version: number }>('PRAGMA user_version');
  assert.equal(user_version, SCHEMA_VERSION);
  cleanup();
});

test('every time-series table carries target_id', () => {
  const { read, cleanup } = tmpStore();
  for (const t of ['run', 'request', 'gauge']) {
    const cols = read<{ name: string }>(`PRAGMA table_info(${t})`).map(c => c.name);
    assert.ok(cols.includes('target_id'), `${t} is missing target_id`);
  }
  cleanup();
});

test('run drops the MTPLX-only columns and gains the rapid-mlx ones', () => {
  const { read, cleanup } = tmpStore();
  const cols = read<{ name: string }>('PRAGMA table_info(run)').map(c => c.name);
  for (const gone of ['pid', 'runtime_mode', 'generation_mode', 'depth', 'verify_core', 'paged_kv_quantization']) {
    assert.equal(cols.includes(gone), false, `run should not have ${gone}`);
  }
  for (const added of ['version', 'kv_cache_dtype', 'turboquant_mode', 'spec_decode_method', 'engine_type']) {
    assert.ok(cols.includes(added), `run is missing ${added}`);
  }
  cleanup();
});

test('request sheds the MTP block and gains the proxy columns', () => {
  const { read, cleanup } = tmpStore();
  const cols = read<{ name: string }>('PRAGMA table_info(request)').map(c => c.name);
  for (const gone of ['drafted_by_depth', 'accepted_by_depth', 'accept_rate', 'mtp_depth',
                      'bonus_tokens', 'correction_tokens', 'verify_calls', 'draft_time_s',
                      'verify_forward_time_s', 'verify_eval_time_s', 'accept_time_s',
                      'cache_source', 'session_cache_hit', 'cached_tokens',
                      'cache_restore_time_s', 'ssd_cache_hit', 'ssd_cached_tokens']) {
    assert.equal(cols.includes(gone), false, `request should not have ${gone}`);
  }
  for (const added of ['outcome', 'status_code', 'streamed', 'finish_reason', 'engine_joined']) {
    assert.ok(cols.includes(added), `request is missing ${added}`);
  }
  cleanup();
});

test('REQUEST_SERIES keeps only the two request-derived sparklines', () => {
  assert.deepEqual(Object.keys(REQUEST_SERIES).sort(), ['decode', 'ttft']);
});

/* Spec section 5: no migration. The old file is moved aside, WAL sidecars and
   all, and a fresh database takes its place. */
test('a v1 database is set aside rather than migrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const old = new DatabaseSync(file);
  old.exec('PRAGMA user_version = 1');
  old.exec('CREATE TABLE legacy (x INTEGER)');
  old.exec('INSERT INTO legacy VALUES (42)');
  old.close();

  const store = createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 });
  assert.equal(store.status().ok, true);

  const aside = path.join(dir, 'history-v1.db');
  assert.ok(fs.existsSync(aside), 'old database was not set aside');

  const kept = new DatabaseSync(aside);
  // See the comment on tmpStore's `read` helper re: null-prototype rows.
  assert.deepEqual(
    kept.prepare('SELECT x FROM legacy').all().map(r => ({ ...(r as object) })),
    [{ x: 42 }]
  );
  kept.close();

  const fresh = new DatabaseSync(file);
  const [{ user_version }] = fresh.prepare('PRAGMA user_version').all() as { user_version: number }[];
  assert.equal(user_version, SCHEMA_VERSION);
  assert.equal(
    fresh.prepare(`SELECT name FROM sqlite_master WHERE name = 'legacy'`).all().length,
    0,
    'fresh database should not contain the old schema'
  );
  fresh.close();

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* fs.renameSync clobbers silently. The realistic trigger is a user copying
   their archive back to the live path to inspect it. */
test('a second set-aside never destroys the first archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const makeV1 = (x: number) => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 1');
    db.exec('CREATE TABLE legacy (x INTEGER)');
    db.exec(`INSERT INTO legacy VALUES (${x})`);
    db.close();
  };
  const rows = (f: string) => {
    const db = new DatabaseSync(f);
    try {
      return (db.prepare('SELECT x FROM legacy').all() as { x: number }[]).map(r => ({ ...r }).x);
    } finally {
      db.close();
    }
  };
  const opts = { enabled: true, retentionDays: 30, transcriptRetentionDays: 7 };

  makeV1(42);
  createStore({ path: file, ...opts }).close();
  fs.rmSync(file);

  makeV1(7);
  createStore({ path: file, ...opts }).close();

  assert.deepEqual(rows(path.join(dir, 'history-v1.db')), [42], 'first archive was destroyed');
  assert.deepEqual(rows(path.join(dir, 'history-v1.2.db')), [7]);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* The -wal/-shm move is the whole reason this block exists; without it a stale
   WAL can be replayed into the fresh database. Sidecars are written as plain
   files here because setAsideIfStale only tests existence and renames. */
test('WAL sidecars move with the set-aside database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 1');
  db.exec('CREATE TABLE legacy (x INTEGER)');
  db.close();
  fs.writeFileSync(file + '-wal', 'stale-wal');
  fs.writeFileSync(file + '-shm', 'stale-shm');

  createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 }).close();

  const aside = path.join(dir, 'history-v1.db');
  assert.equal(fs.readFileSync(aside + '-wal', 'utf8'), 'stale-wal');
  assert.equal(fs.readFileSync(aside + '-shm', 'utf8'), 'stale-shm');
  assert.equal(fs.existsSync(file + '-wal'), false, 'stale -wal left beside the fresh database');
  assert.equal(fs.existsSync(file + '-shm'), false, 'stale -shm left beside the fresh database');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an orphaned sidecar does not get overwritten by a set-aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 1');
  db.exec('CREATE TABLE legacy (x INTEGER)');
  db.close();
  fs.writeFileSync(file + '-wal', 'incoming-wal');

  /* An archive whose .db was deleted but whose sidecar was left behind. */
  fs.writeFileSync(path.join(dir, 'history-v1.db-wal'), 'orphan');

  createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 }).close();

  assert.equal(
    fs.readFileSync(path.join(dir, 'history-v1.db-wal'), 'utf8'),
    'orphan',
    'orphaned sidecar was overwritten'
  );
  assert.equal(fs.readFileSync(path.join(dir, 'history-v1.2.db-wal'), 'utf8'), 'incoming-wal');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a matching version is left alone', () => {
  const { store, file, dir, cleanup } = tmpStore();
  store.close();
  const reopened = createStore({ path: file, enabled: true, retentionDays: 30, transcriptRetentionDays: 7 });
  assert.equal(reopened.status().ok, true);
  assert.equal(fs.existsSync(path.join(dir, `history-v${SCHEMA_VERSION}.db`)), false);
  reopened.close();
  cleanup();
});

test('disabled store is inert and never touches the filesystem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const file = path.join(dir, 'history.db');
  const store = createStore({ path: file, enabled: false, retentionDays: 30, transcriptRetentionDays: 7 });

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
    transcriptRetentionDays: 7,
  });
  assert.equal(store.status().ok, false);
  assert.ok(store.status().lastError);
  store.close(); // must not throw on a store that never opened

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------- */
/* Runs                                                                    */
/* ---------------------------------------------------------------------- */

test('upsertRun is idempotent for the same target and start time', () => {
  const { store, read, cleanup } = tmpStore();
  const a = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const b = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_002_000);
  assert.equal(typeof a, 'number');
  assert.equal(b, a);
  assert.equal(read<RunRow>(RUNS).length, 1);
  cleanup();
});

/* R26: this exact-repeat idempotency must not just return the right id — it
   must not touch `ok`/`lastError` at all. R25 gated the exact-match lookup on
   `opts.adopt`, so a default-options repeat fell through to INSERT and hit
   the `run_identity` UNIQUE index; fail() then set ok=false, which
   Store.status() feeds into StatePayload.persist, degrading the dashboard's
   reported persistence health for something entirely benign. */
test('an exact-origin repeat with default options does not degrade the store', () => {
  const { store, read, cleanup } = tmpStore();
  const a = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const b = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_002_000);
  assert.equal(typeof a, 'number');
  assert.equal(b, a);
  assert.equal(store.status().ok, true);
  assert.equal(store.status().lastError, null);
  assert.equal(read<RunRow>(RUNS).length, 1);
  cleanup();
});

test('a new run for the same target closes the previous one', () => {
  const { store, read, cleanup } = tmpStore();
  const first = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const second = store.upsertRun(runInfo('qwen', 1_700_000_500_000), 1_700_000_501_000);
  assert.notEqual(second, first);

  const rows = read<RunRow>(RUNS);
  const closed = rows.find(r => r.id === first);
  const open = rows.find(r => r.id === second);
  assert.equal(closed?.ended_at, 1_700_000_501_000);
  assert.equal(open?.ended_at, null);
  cleanup();
});

/* Spec/3f: closing must be scoped to the restarting target only — another
   target's run is unrelated and must survive. */
test("a new run for a different target does not close the other target's open run", () => {
  const { store, read, cleanup } = tmpStore();
  const qwen = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const gemma = store.upsertRun(runInfo('gemma', 1_700_000_000_500), 1_700_000_001_500);

  const rows = read<RunRow>(RUNS);
  assert.equal(rows.find(r => r.id === qwen)?.ended_at, null);
  assert.equal(rows.find(r => r.id === gemma)?.ended_at, null);
  cleanup();
});

test('run promotes rapid-mlx columns and keeps the raw JSON', () => {
  const { store, read, cleanup } = tmpStore();
  const id = store.upsertRun(runInfo('qwen', 1_700_000_000_000, { kvCacheDtype: 'int8' }), 1_700_000_001_000);
  const row = read<RunRow>(RUNS).find(r => r.id === id);
  assert.equal(row?.kv_cache_dtype, 'int8');
  assert.equal(row?.engine_type, 'mlx');
  assert.equal(row?.target_id, 'qwen');
  assert.deepEqual(JSON.parse(String(row?.health)), { ok: true });
  cleanup();
});

test('upsertRun on a disabled store returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: false,
    retentionDays: 30,
    transcriptRetentionDays: 7,
  });
  assert.equal(store.upsertRun(runInfo('qwen', 2), 3), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* Run identity must survive a dashboard restart: runTracker re-derives
   `started_at` as `now - uptime * 1000` from scratch on every dashboard
   process start, and independent sampling of `now`/`uptime` means the result
   wanders by a few ms between dashboard lifetimes even though the underlying
   inference process never restarted. See RUN_IDENTITY_TOLERANCE_MS. */

test('a dashboard restart does not mint a second run', () => {
  const { store, read, cleanup } = tmpStore();
  const a = store.upsertRun(runInfo('qwen', 1_788_600_081_483), 1_788_600_082_000);
  const b = store.upsertRun(runInfo('qwen', 1_788_600_081_486), 1_788_600_083_000, { adopt: true });
  assert.equal(typeof a, 'number');
  assert.equal(b, a);
  assert.equal(read<RunRow>(RUNS).length, 1);
  cleanup();
});

test('adopting a nearby run reopens one wrongly closed by this same bug', () => {
  const { store, read, file, cleanup } = tmpStore();
  const id = store.upsertRun(runInfo('qwen', 1_788_600_081_483), 1_788_600_082_000);

  // Simulate a previous dashboard restart that falsely stamped ended_at.
  const db = new DatabaseSync(file);
  db.prepare('UPDATE run SET ended_at = ? WHERE id = ?').run(1_788_630_490_195, id as number);
  db.close();
  assert.equal(read<RunRow>(RUNS).find(r => r.id === id)?.ended_at, 1_788_630_490_195);

  const again = store.upsertRun(runInfo('qwen', 1_788_600_081_486), 1_788_630_600_000, { adopt: true });
  assert.equal(again, id);
  assert.equal(read<RunRow>(RUNS).find(r => r.id === id)?.ended_at, null);
  cleanup();
});

test('a genuine restart (origin outside tolerance) still creates a new run', () => {
  const { store, read, cleanup } = tmpStore();
  const first = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const second = store.upsertRun(runInfo('qwen', 1_700_000_000_000 + 3_600_000), 1_700_000_001_000 + 3_600_000);
  assert.notEqual(second, first);

  const rows = read<RunRow>(RUNS);
  assert.equal(rows.find(r => r.id === first)?.ended_at, 1_700_000_001_000 + 3_600_000);
  assert.equal(rows.find(r => r.id === second)?.ended_at, null);
  cleanup();
});

test('identity tolerance does not cross target boundaries', () => {
  const { store, read, cleanup } = tmpStore();
  const qwen = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const gemma = store.upsertRun(runInfo('gemma', 1_700_000_000_000), 1_700_000_001_000, { adopt: true });
  assert.notEqual(gemma, qwen);
  assert.equal(read<RunRow>(RUNS).length, 2);
  cleanup();
});

test('adoption prefers the nearest run when more than one is in range', () => {
  const { store, cleanup } = tmpStore();
  // 40s apart so neither adopts the other while being created.
  const gap = RUN_IDENTITY_TOLERANCE_MS + 10_000;
  const first = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_000_500);
  const second = store.upsertRun(runInfo('qwen', 1_700_000_000_000 + gap), 1_700_000_000_500 + gap);
  assert.notEqual(second, first);

  // 1s from `second`'s origin, comfortably within tolerance of both — nearest wins.
  const adopted = store.upsertRun(
    runInfo('qwen', 1_700_000_000_000 + gap + 1_000),
    1_700_000_000_500 + gap + 1_000,
    { adopt: true }
  );
  assert.equal(adopted, second);
  cleanup();
});

/* R25: adoption must be conditioned on *why* upsertRun is being called, not on
   distance alone — a crash loop (short-lived process, each restart landing
   well within RUN_IDENTITY_TOLERANCE_MS of the last) must mint a new run per
   life rather than being folded into one never-closed row. See the updated
   RUN_IDENTITY_TOLERANCE_MS comment and the `adopt` option on upsertRun. */

test('a crash loop is not merged into one run', () => {
  const { store, read, cleanup } = tmpStore();
  // Three lives, ~5s apart — well inside tolerance, but each call declares
  // `adopt: false` because runTracker only sets `adopt: true` on a first
  // observation, and a crash loop is a detected restart every time.
  const first = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_000_100, { adopt: false });
  const second = store.upsertRun(runInfo('qwen', 1_700_000_005_000), 1_700_000_005_100, { adopt: false });
  const third = store.upsertRun(runInfo('qwen', 1_700_000_010_000), 1_700_000_010_100, { adopt: false });

  assert.equal(typeof first, 'number');
  assert.equal(typeof second, 'number');
  assert.equal(typeof third, 'number');
  assert.notEqual(second, first);
  assert.notEqual(third, second);
  assert.notEqual(third, first);

  const rows = read<RunRow>(RUNS);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.id === first)?.ended_at, 1_700_000_005_100);
  assert.equal(rows.find(r => r.id === second)?.ended_at, 1_700_000_010_100);
  assert.equal(rows.find(r => r.id === third)?.ended_at, null);
  cleanup();
});

test('adoption still works when the caller allows it', () => {
  const { store, read, cleanup } = tmpStore();
  // This is the dashboard-restart case R24 fixed: same process, origin off by
  // a few ms because now/uptime were sampled independently again.
  const first = store.upsertRun(runInfo('qwen', 1_788_600_081_483), 1_788_600_082_000);
  const second = store.upsertRun(runInfo('qwen', 1_788_600_081_486), 1_788_600_083_000, { adopt: true });
  assert.equal(typeof first, 'number');
  assert.equal(second, first);
  assert.equal(read<RunRow>(RUNS).length, 1);
  cleanup();
});

test('the default is not to adopt', () => {
  const { store, read, cleanup } = tmpStore();
  // No options at all — a future caller that forgets the flag should
  // over-report runs, not silently merge a crash loop into one.
  const first = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_000_500);
  const second = store.upsertRun(runInfo('qwen', 1_700_000_000_005), 1_700_000_000_505);
  assert.equal(typeof first, 'number');
  assert.equal(typeof second, 'number');
  assert.notEqual(second, first);
  assert.equal(read<RunRow>(RUNS).length, 2);
  cleanup();
});

/* ---------------------------------------------------------------------- */
/* Requests / transcripts                                                  */
/* ---------------------------------------------------------------------- */

test('gauges are scoped by target', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertGauge('qwen', 'requests_running', 1, 1000);
  store.insertGauge('gemma', 'requests_running', 5, 1000);
  const rows = read<{ target_id: string; value: number }>(
    `SELECT target_id, value FROM gauge ORDER BY target_id`
  );
  assert.deepEqual(rows, [
    { target_id: 'gemma', value: 5 },
    { target_id: 'qwen', value: 1 },
  ]);
  cleanup();
});

test('insertRequestRow maps fields onto the request table', () => {
  const { store, read, cleanup } = tmpStore();
  const runId = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  store.insertRequestRow({ ...REQ, runId });

  const rows = read(REQUESTS);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.request_id, 'req-1');
  assert.equal(r.target_id, 'qwen');
  assert.equal(r.run_id, runId);
  assert.equal(r.ts, 1_700_000_002_000);
  assert.equal(r.prompt_tokens, 436);
  assert.equal(r.client_label, 'opencode');
  assert.equal(r.user_preview, 'hello there');
  assert.equal(r.streamed, 1);
  assert.equal(r.engine_joined, 1);
  cleanup();
});

test('booleans become 0/1 and absent optional fields become null', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequestRow({
    requestId: 'req-2',
    targetId: 'qwen',
    runId: null,
    ts: 1_700_000_002_000,
    streamed: false,
  });
  const r = read(REQUESTS)[0];
  assert.equal(r.streamed, 0);
  assert.equal(r.run_id, null);
  assert.equal(r.status_code, null);
  assert.equal(r.outcome, null);
  cleanup();
});

test('re-inserting the same request_id preserves the original row', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequestRow({ ...REQ });
  store.insertRequestRow({ ...REQ, promptTokens: 999, ts: 1_700_000_999_000 });

  const rows = read(REQUESTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, 1_700_000_002_000);
  assert.equal(rows[0].prompt_tokens, 436);
  cleanup();
});

test('insertTranscript takes ts from the parent request row', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertRequestRow({ requestId: 'r1', targetId: 'qwen', runId: null, ts: 1_700_000_002_000 });
  store.insertTranscript('r1', '[{"role":"user","content":"hi"}]', 'hello', null, false);

  const rows = read<{ request_id: string; ts: number; messages: string; truncated: number }>(
    'SELECT * FROM transcript'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'r1');
  assert.equal(rows[0].ts, 1_700_000_002_000);
  assert.deepEqual(JSON.parse(rows[0].messages), [{ role: 'user', content: 'hi' }]);
  assert.equal(rows[0].truncated, 0);
  cleanup();
});

test('insertTranscript is a no-op when the parent request row is missing', () => {
  const { store, read, cleanup } = tmpStore();
  store.insertTranscript('ghost', '[]', 'x', null, false);
  assert.equal(read('SELECT 1 FROM transcript').length, 0);
  cleanup();
});

/* Transcripts age out on their own clock so bodies do not force the metrics
   history to be short, and metrics retention does not force bodies to be kept. */
test('transcripts prune on their own retention, ahead of requests', () => {
  const { store, read, cleanup } = tmpStore(30, 7);
  const now = Date.UTC(2026, 8, 5);
  const tenDaysAgo = now - 10 * 86_400_000;

  store.insertRequestRow({ requestId: 'r1', targetId: 'qwen', runId: null, ts: tenDaysAgo });
  store.insertTranscript('r1', '[{"role":"user","content":"hi"}]', 'hello', null, false);

  assert.equal(read(`SELECT 1 FROM transcript`).length, 1);
  store.prune(now);
  assert.equal(read(`SELECT 1 FROM transcript`).length, 0, 'transcript should be pruned at 7d');
  assert.equal(read(`SELECT 1 FROM request`).length, 1, 'request should survive to 30d');
  cleanup();
});

test('gaugeNames lists the distinct series recorded for a target', () => {
  const { store, cleanup } = tmpStore();
  store.insertGauge('qwen', 'active_requests', 1, 1000);
  store.insertGauge('qwen', 'requests_running', 2, 1000);
  store.insertGauge('gemma', 'active_requests', 3, 1000);
  assert.deepEqual(store.gaugeNames('qwen'), ['active_requests', 'requests_running']);
  cleanup();
});

/* ---------------------------------------------------------------------- */
/* Series queries                                                          */
/* ---------------------------------------------------------------------- */

test('querySeries buckets request rows and reports bucket starts', () => {
  const { store, cleanup } = tmpStore();
  const base = 1_700_000_000_000;
  // two requests in bucket 0, one in bucket 2, over a 4-bucket window
  store.insertRequestRow({ requestId: 'a', targetId: 'qwen', runId: null, ts: base + 100, decodeTokS: 10 });
  store.insertRequestRow({ requestId: 'b', targetId: 'qwen', runId: null, ts: base + 200, decodeTokS: 20 });
  store.insertRequestRow({ requestId: 'c', targetId: 'qwen', runId: null, ts: base + 2500, decodeTokS: 50 });

  const res = store.querySeries('qwen', ['decode'], base, base + 4000, 4);
  assert.equal(res.bucketMs, 1000);
  assert.deepEqual(res.series.decode, [
    { ts: base, avg: 15, min: 10, max: 20, n: 2 },
    { ts: base + 2000, avg: 50, min: 50, max: 50, n: 1 },
  ]);
  cleanup();
});

test('querySeries rejects names outside the allowlist', () => {
  const { store, cleanup } = tmpStore();
  assert.throws(() => store.querySeries('qwen', ['ttft; DROP TABLE request'], 0, 1000, 1), /unknown series/i);
  assert.deepEqual(Object.keys(REQUEST_SERIES).sort(), ['decode', 'ttft']);
  for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => store.querySeries('qwen', [evil], 0, 1000, 1), /unknown series/i);
  }
  assert.equal(store.status().ok, true); // a rejected name must not degrade store health
  cleanup();
});

test('gauges round-trip through queryGauges', () => {
  const { store, cleanup } = tmpStore();
  const base = 1_700_000_000_000;
  store.insertGauge('qwen', 'session_bank_bytes', 100, base + 10);
  store.insertGauge('qwen', 'session_bank_bytes', 300, base + 20);
  store.insertGauge('qwen', 'active_requests', 1, base + 10);

  const res = store.queryGauges('qwen', ['session_bank_bytes'], base, base + 1000, 1);
  assert.deepEqual(res.series.session_bank_bytes, [
    { ts: base, avg: 200, min: 100, max: 300, n: 2 },
  ]);
  cleanup();
});

test('an empty window yields an empty array, not an error', () => {
  const { store, cleanup } = tmpStore();
  const res = store.querySeries('qwen', ['decode', 'ttft'], 0, 1000, 10);
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
    transcriptRetentionDays: 7,
  });
  const res = store.querySeries('qwen', ['decode'], 0, 1000, 10);
  assert.deepEqual(res.series.decode, []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------- */
/* Prune                                                                   */
/* ---------------------------------------------------------------------- */

test('prune drops rows past the retention cutoff', () => {
  const { store, read, cleanup } = tmpStore(1); // 1-day retention
  const now = 1_700_000_000_000;
  store.insertRequestRow({ requestId: 'old', targetId: 'qwen', runId: null, ts: now - 2 * DAY });
  store.insertRequestRow({ requestId: 'new', targetId: 'qwen', runId: null, ts: now - 1000 });
  store.insertGauge('qwen', 'active_requests', 1, now - 2 * DAY);
  store.insertGauge('qwen', 'active_requests', 2, now - 1000);

  store.prune(now);

  const ids = read(REQUESTS).map(r => r.request_id);
  assert.deepEqual(ids, ['new']);
  const g = store.queryGauges('qwen', ['active_requests'], now - 3 * DAY, now + 1000, 1);
  assert.equal(g.series.active_requests[0].n, 1);
  cleanup();
});

test('prune keeps the open run but drops old closed runs', () => {
  const { store, read, cleanup } = tmpStore(1);
  const now = 1_700_000_000_000;
  const old = store.upsertRun(runInfo('qwen', now - 3 * DAY), now - 3 * DAY);
  /* The SECOND call's `now` is what stamps ended_at on the first run, so it must
     sit before the retention cutoff for that run to become prunable. Same
     target as `old` so upsertRun's same-target close rule actually closes it. */
  const open = store.upsertRun(runInfo('qwen', now - 2 * DAY), now - 2 * DAY);
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
  store.insertRequestRow({ requestId: 'a', targetId: 'qwen', runId: null, ts: now - 1 });
  store.prune(now);
  assert.equal(read(REQUESTS).length, 0);
  cleanup();
});

/* ---------------------------------------------------------------------- */
/* queryRuns / getRun                                                      */
/* ---------------------------------------------------------------------- */

test('queryRuns returns an empty array when there are no runs', () => {
  const { store, cleanup } = tmpStore();
  assert.deepEqual(store.queryRuns(20), []);
  cleanup();
});

test('queryRuns includes a run with zero requests, aggregates null', () => {
  const { store, cleanup } = tmpStore();
  const runA = store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  const summaries = store.queryRuns(20);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, runA);
  assert.equal(summaries[0].requestCount, 0);
  assert.deepEqual(summaries[0].decode, { avg: null, min: null, max: null });
  assert.deepEqual(summaries[0].ttft, { avg: null, min: null, max: null });
  cleanup();
});

test('queryRuns aggregates requests per run and orders newest-first', () => {
  const { store, cleanup } = tmpStore();
  const runA = store.upsertRun(runInfo('qwen', 1_700_000_000_000, { model: 'model-a' }), 1_700_000_001_000);
  const runB = store.upsertRun(runInfo('gemma', 1_700_000_500_000, { model: 'model-b' }), 1_700_000_501_000);

  store.insertRequestRow({
    requestId: 'a1', targetId: 'qwen', runId: runA, ts: 1_700_000_002_000, decodeTokS: 10, ttftS: 1.0,
  });
  store.insertRequestRow({
    requestId: 'a2', targetId: 'qwen', runId: runA, ts: 1_700_000_003_000, decodeTokS: 20, ttftS: 2.0,
  });
  store.insertRequestRow({
    requestId: 'b1', targetId: 'gemma', runId: runB, ts: 1_700_000_502_000, decodeTokS: 100, ttftS: 0.1,
  });

  const summaries = store.queryRuns(20);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].id, runB);
  assert.equal(summaries[0].requestCount, 1);
  assert.deepEqual(summaries[0].decode, { avg: 100, min: 100, max: 100 });
  assert.equal(summaries[1].id, runA);
  assert.equal(summaries[1].requestCount, 2);
  assert.deepEqual(summaries[1].decode, { avg: 15, min: 10, max: 20 });
  assert.deepEqual(summaries[1].ttft, { avg: 1.5, min: 1.0, max: 2.0 });
  cleanup();
});

test('queryRuns respects limit', () => {
  const { store, cleanup } = tmpStore();
  store.upsertRun(runInfo('qwen', 1_700_000_000_000), 1_700_000_001_000);
  store.upsertRun(runInfo('qwen', 1_700_000_500_000), 1_700_000_501_000);
  const runC = store.upsertRun(runInfo('qwen', 1_700_001_000_000), 1_700_001_001_000);
  const summaries = store.queryRuns(1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, runC);
  cleanup();
});

test('a disabled store returns an empty run list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: false,
    retentionDays: 30,
    transcriptRetentionDays: 7,
  });
  assert.deepEqual(store.queryRuns(20), []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRun returns the full run including parsed health', () => {
  const { store, cleanup } = tmpStore();
  const health = JSON.stringify({ ok: true, foo: 'bar' });
  const id = store.upsertRun(
    runInfo('qwen', 1_700_000_000_000, { kvCacheDtype: 'int8', health }),
    1_700_000_001_000
  ) as number;
  const detail = store.getRun(id) as RunDetail;
  assert.ok(detail);
  assert.equal(detail.id, id);
  assert.equal(detail.startedAt, 1_700_000_000_000);
  assert.equal(detail.kvCacheDtype, 'int8');
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
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: false,
    retentionDays: 30,
    transcriptRetentionDays: 7,
  });
  assert.equal(store.getRun(1), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stores a dream run and reads it back as a night', () => {
  const { store, cleanup } = tmpStore(); // existing helper: throwaway on-disk sqlite
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    'Dream cycle (partial) in 1.4s:',
    '  ✓ lint  0 fix(es) applied; 335 non-fixable',
    '  ! extract_facts  skipped: 5 legacy facts',
    '[dream-nightly] stamped last_full_cycle_at for default',
    '[dream-nightly] WARN: global pass failed (rc=143)',
    '[dream-nightly:commit] default committed e7fd46f',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);

  const id = store.insertDreamRun(run, 'e7fd46f', 'both');
  assert.ok(id !== null);

  store.upsertDreamNight('2026-09-05', Date.parse('2026-09-05T07:05:00'), id, 'warned');
  const nights = store.queryDreamNights(10);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].date, '2026-09-05');
  assert.equal(nights[0].status, 'warned');

  const detail = store.getDreamNight('2026-09-05');
  assert.ok(detail);
  assert.equal(detail.run?.globalPassRc, 143);
  assert.equal(detail.run?.commitSource, 'both');
  assert.equal(detail.phases.length, 2);
  assert.equal(detail.phases.find((p) => p.phase === 'extract_facts')?.mark, 'noop');
  cleanup();
});

test('a missed night is a row with no run', () => {
  const { store, cleanup } = tmpStore();
  store.upsertDreamNight('2026-09-03', Date.parse('2026-09-03T07:05:00'), null, 'missed');
  const [night] = store.queryDreamNights(10);
  assert.equal(night.status, 'missed');
  assert.equal(night.runId, null);
  assert.equal(store.getDreamNight('2026-09-03')?.run, null);
  cleanup();
});

test('nested item failures survive the round trip', () => {
  const { store, cleanup } = tmpStore();
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    '[dream-nightly] stamped last_full_cycle_at for default',
    'Dream cycle (partial) in 812.4s:',
    '  ! extract_atoms  124 atoms (1 failed)',
    '      ✗ career-ops/by-company/n8n: unparseable JSON array',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  const id = store.insertDreamRun(run, null, 'none');
  store.upsertDreamNight('2026-09-05', 0, id, 'warned');

  const phase = store.getDreamNight('2026-09-05')!.phases[0];
  assert.equal(phase.failureCount, 1);
  assert.deepEqual(JSON.parse(phase.failuresJson!)[0].slug, 'career-ops/by-company/n8n');
  cleanup();
});

test('ingest offset round-trips and defaults to zero', () => {
  const { store, cleanup } = tmpStore();
  assert.equal(store.dreamIngestOffset(), 0);
  store.setDreamIngestOffset(4096);
  assert.equal(store.dreamIngestOffset(), 4096);
  cleanup();
});

test('phase names are stored as values, not interpolated', () => {
  const { store, cleanup } = tmpStore();
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    'Dream cycle (partial) in 1.0s:',
    "  ✓ lint  0 fix(es); '); DROP TABLE dream_run; --",
    '[dream-nightly] stamped last_full_cycle_at for default',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  const id = store.insertDreamRun(run, null, 'none');
  store.upsertDreamNight('2026-09-05', 0, id, 'ok');
  assert.equal(store.queryDreamNights(10).length, 1, 'dream_run must still exist');
  cleanup();
});
