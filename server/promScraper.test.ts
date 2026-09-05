import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus } from './promParse';
import { CounterState } from './promSeries';
import { deriveSamples } from './promScraper';

const read = (n: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

const COLD = read('rapid-mlx-0.13.4-cold.txt');
const AFTER = read('rapid-mlx-0.13.4-after-first-request.txt');

test('a cold scrape yields no samples at all', () => {
  const c = new CounterState();
  const d = deriveSamples(parsePrometheus(COLD), c);
  assert.equal(d.decode, null);
  assert.equal(d.ttft, null);
  assert.equal(d.completedDelta, null); // first observation has no baseline
});

test('the first delta after a cold scrape yields the real request', () => {
  const c = new CounterState();
  deriveSamples(parsePrometheus(COLD), c); // establish the baseline
  const d = deriveSamples(parsePrometheus(AFTER), c);
  assert.equal(d.completedDelta, 1);
  assert.equal(d.decode, 36.726379);
  /* ttft_sum 0.393659 over ttft_count 1 */
  assert.ok(d.ttft !== null && Math.abs(d.ttft - 0.393659) < 1e-9);
});

/* _last holds the same value until another request completes. Re-sampling it
   every second would flatten the sparkline with duplicates. */
test('decode is not re-sampled while the completed counter is flat', () => {
  const c = new CounterState();
  deriveSamples(parsePrometheus(COLD), c);
  deriveSamples(parsePrometheus(AFTER), c);
  const again = deriveSamples(parsePrometheus(AFTER), c);
  assert.equal(again.completedDelta, 0);
  assert.equal(again.decode, null);
  assert.equal(again.ttft, null);
});

test('ttft is the mean over the interval when several requests complete', () => {
  const c = new CounterState();
  const base = parsePrometheus(
    'rapid_mlx_requests_processed_total 10\n' +
    'rapid_mlx_model_ttft_seconds_sum 1.0\n' +
    'rapid_mlx_model_ttft_seconds_count 10\n'
  );
  const next = parsePrometheus(
    'rapid_mlx_requests_processed_total 14\n' +
    'rapid_mlx_model_ttft_seconds_sum 3.0\n' +
    'rapid_mlx_model_ttft_seconds_count 14\n'
  );
  deriveSamples(base, c);
  const d = deriveSamples(next, c);
  assert.equal(d.completedDelta, 4);
  assert.equal(d.ttft, 0.5); // 2.0s over 4 requests
});

test('a counter reset yields nulls rather than a spike', () => {
  const c = new CounterState();
  deriveSamples(parsePrometheus(COLD), c);
  deriveSamples(parsePrometheus(AFTER), c);
  const restarted = deriveSamples(parsePrometheus(COLD), c); // counters back to 0
  assert.equal(restarted.completedDelta, null);
  assert.equal(restarted.decode, null);
  assert.equal(restarted.ttft, null);
});
