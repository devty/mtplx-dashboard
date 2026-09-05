import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus } from './promParse';
import { CounterState } from './promSeries';
import { deriveSamples, isCumulative, cumulativeRate } from './promScraper';

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

/* The declared type must beat the name. rapid-mlx already ships gauges whose
   names end in a counter-ish suffix, so a name-first rule silently differences
   them into nonsense. */
test('isCumulative trusts the declared type over the name', () => {
  const s = parsePrometheus(
    '# TYPE a_total counter\na_total 1\n' +
    '# TYPE b_seconds histogram\nb_seconds_bucket{le="1"} 1\nb_seconds_sum 0.5\nb_seconds_count 1\n' +
    '# TYPE b_seconds_max gauge\nb_seconds_max 0.5\n' +
    '# TYPE c_count gauge\nc_count 7\n' +
    '# TYPE d gauge\nd 3\n'
  );
  assert.equal(isCumulative(s, 'a_total'), true, 'declared counter');
  assert.equal(isCumulative(s, 'b_seconds_bucket'), true, 'histogram component');
  assert.equal(isCumulative(s, 'b_seconds_sum'), true, 'histogram component');
  assert.equal(isCumulative(s, 'b_seconds_count'), true, 'histogram component');
  assert.equal(isCumulative(s, 'b_seconds_max'), false, 'declared gauge on a histogram family');
  assert.equal(isCumulative(s, 'c_count'), false, 'gauge whose NAME ends in _count');
  assert.equal(isCumulative(s, 'd'), false, 'plain gauge');
});

test('isCumulative classifies the real fixture families correctly', () => {
  const s = parsePrometheus(AFTER);
  assert.equal(isCumulative(s, 'rapid_mlx_requests_processed_total'), true);
  assert.equal(isCumulative(s, 'rapid_mlx_model_ttft_seconds_bucket'), true);
  assert.equal(isCumulative(s, 'rapid_mlx_model_ttft_seconds_count'), true);
  assert.equal(isCumulative(s, 'rapid_mlx_model_decode_tokens_per_second_last'), false);
  assert.equal(isCumulative(s, 'rapid_mlx_model_ttft_seconds_max'), false);
  assert.equal(isCumulative(s, 'rapid_mlx_uptime_seconds'), false);
});

/* I3 (final-review finding): persistGauges() used to store a cumulative
   counter's raw per-interval delta, which is only comparable to another
   delta taken over the same elapsed window. persistGauges is only reachable
   from pollOnce's success path, so under scrape backoff or an outage that
   window varies — the SAME delta taken over a longer gap must persist as a
   proportionally SMALLER rate, not the same raw number, or queryGauges()
   would average a 10s delta and a 30s delta together as if they were the
   same unit and read a threefold recovery burst as a traffic spike. */
test('cumulativeRate: the same delta over a longer elapsed window yields a proportionally smaller rate', () => {
  const tenSecondRate = cumulativeRate(3, 10_000);
  const thirtySecondRate = cumulativeRate(3, 30_000);
  assert.ok(tenSecondRate !== null && thirtySecondRate !== null);
  // Same raw delta (3), but the 30s window is 3x longer than the 10s window —
  // the stored rate must be exactly 1/3 as large, not identical.
  assert.ok(Math.abs(tenSecondRate - 0.3) < 1e-9);
  assert.ok(Math.abs(thirtySecondRate - 0.1) < 1e-9);
  assert.ok(Math.abs(tenSecondRate / thirtySecondRate - 3) < 1e-9);
});

test('cumulativeRate returns null for a first sighting (null delta) or a non-positive elapsed window', () => {
  assert.equal(cumulativeRate(null, 10_000), null);
  assert.equal(cumulativeRate(5, 0), null);
  assert.equal(cumulativeRate(5, -1), null);
});
