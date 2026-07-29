import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, SCHEMA_VERSION } from './db';
import type { RunInfo, RunRow } from './db';
import type { MetricsRecord } from './types';

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
  assert.deepEqual(Object.keys(REQUEST_SERIES).sort(), ['accept', 'decode', 'prefill', 'ttft']);
  for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => store.querySeries([evil], 0, 1000, 1), /unknown series/i);
  }
  assert.equal(store.status().ok, true); // a rejected name must not degrade store health
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
  const open = store.upsertRun(runInfo(2, now - 1000), now - 2 * DAY);
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
