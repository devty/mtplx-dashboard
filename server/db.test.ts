import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SCHEMA_VERSION } from './db';
import type { RunInfo, RunRow } from './db';

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
