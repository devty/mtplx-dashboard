import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus } from './promParse';
import { RunTracker } from './runTracker';
import type { RunInfo } from './db';

const fixture = (name: string) =>
  parsePrometheus(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

/** Records upsertRun calls and hands back increasing ids. */
function fakeStore() {
  const calls: RunInfo[] = [];
  let next = 1;
  return {
    calls,
    upsertRun(info: RunInfo): number | null {
      calls.push(info);
      return next++;
    },
  };
}

/** A scrape with a chosen uptime, otherwise identical to the real fixture. */
function scrapeWithUptime(uptimeS: number) {
  const text = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'rapid-mlx-0.13.4-after-first-request.txt'), 'utf8')
    .replace(/^rapid_mlx_uptime_seconds .*$/m, `rapid_mlx_uptime_seconds ${uptimeS}`);
  return parsePrometheus(text);
}

test('first observation creates a run', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].targetId, 'qwen');
  assert.equal(store.calls[0].startedAt, 900_000);
  assert.equal(t.getRunId(), 1);
});

/* THE TRAP. uptime has ms precision and scrape timing jitters, so a naive
   recompute derives a slightly different origin every poll and the unique
   index mints a new run every second. startedAt must be computed once and
   held. */
test('uptime drift does not mint new runs', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  const first = store.calls[0].startedAt;

  t.observe(scrapeWithUptime(101.001), {}, 262144, 1_001_000);
  t.observe(scrapeWithUptime(101.997), {}, 262144, 1_002_000);
  t.observe(scrapeWithUptime(103.004), {}, 262144, 1_003_000);

  assert.equal(store.calls.length, 1, 'drift should not create additional runs');
  assert.equal(t.getRunId(), 1);
  assert.equal(first, 900_000);
});

test('uptime going backwards starts a new run with a fresh origin', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(3600), {}, 262144, 5_000_000);
  assert.equal(store.calls.length, 1);

  t.observe(scrapeWithUptime(2), {}, 262144, 6_000_000);
  assert.equal(store.calls.length, 2, 'restart should create a run');
  assert.equal(store.calls[1].startedAt, 5_998_000);
  assert.equal(t.getRunId(), 2);
  assert.equal(t.didRestart(), true);
});

/* The case a bare uptime-decrease test cannot see: the restart happened during
   an outage longer than the new uptime, so uptime comes back HIGHER. */
test('a restart during a long scrape outage is still detected', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  assert.equal(store.calls.length, 1);

  /* Server restarted at t=1_100_000; we only look again two hours later. */
  t.observe(scrapeWithUptime(7200), {}, 262144, 8_300_000);
  assert.equal(store.calls.length, 2, 'restart across the gap was missed');
  assert.equal(store.calls[1].startedAt, 1_100_000);
  assert.equal(t.didRestart(), true);
});

/* The mirror case: the same long outage with NO restart must not invent one. */
test('a long scrape outage without a restart creates no new run', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  /* Ran continuously, so the origin stays at 900_000 either way. */
  t.observe(scrapeWithUptime(7300), {}, 262144, 8_200_000);
  assert.equal(store.calls.length, 1);
  assert.equal(t.didRestart(), false);
});

test('didRestart is false on a steady scrape', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), {}, 262144, 1_000_000);
  t.observe(scrapeWithUptime(101), {}, 262144, 1_001_000);
  assert.equal(t.didRestart(), false);
});

test('reads model and version from build_info', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(fixture('rapid-mlx-0.13.4-after-first-request.txt'), {}, 262144, 1_000_000);
  assert.equal(store.calls[0].version, '0.13.4');
  assert.equal(store.calls[0].model, 'mtplx-qwen38-27b-optimized-speed-fp16');
  assert.equal(t.getModel(), 'mtplx-qwen38-27b-optimized-speed-fp16');
});

/* These gauges emit one series per possible value with 1 on the active one. */
test('reads the active label out of one-hot config gauges', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(fixture('rapid-mlx-0.13.4-after-first-request.txt'), {}, 262144, 1_000_000);
  assert.equal(store.calls[0].kvCacheDtype, 'bf16');
  assert.equal(store.calls[0].turboquantMode, 'disabled');
});

test('picks up the differing family on the gemma backend', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'gemma', store });
  t.observe(fixture('rapid-mlx-0.13.4-gemma.txt'), {}, 262144, 1_000_000);
  assert.equal(store.calls[0].model, 'gemma-4-26b-qat-4bit');
  assert.equal(store.calls[0].specDecodeMethod, 'mtp');
});

test('carries engine_type through from /health', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), { engine_type: 'batched' }, 262144, 1_000_000);
  assert.equal(store.calls[0].engineType, 'batched');
});

test('archives health, status and build_info together', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(scrapeWithUptime(100), { status: 'idle' }, 262144, 1_000_000);
  const archived = JSON.parse(store.calls[0].health);
  assert.equal(archived.health.status, 'idle');
  assert.equal(archived.buildInfo.version, '0.13.4');
});

test('a scrape with no uptime gauge creates no run', () => {
  const store = fakeStore();
  const t = new RunTracker({ targetId: 'qwen', store });
  t.observe(parsePrometheus('rapid_mlx_requests_running 0\n'), {}, null, 1_000_000);
  assert.equal(store.calls.length, 0);
  assert.equal(t.getRunId(), null);
});
