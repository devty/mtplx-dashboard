import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus, findSample } from './promParse';
import { seriesName, CounterState, detectRestart } from './promSeries';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('strips the rapid_mlx_ prefix', () => {
  assert.equal(
    seriesName({ name: 'rapid_mlx_requests_running', labels: {}, value: 0 }),
    'requests_running'
  );
});

test('leaves a non-prefixed name alone', () => {
  assert.equal(seriesName({ name: 'other_metric', labels: {}, value: 0 }), 'other_metric');
});

test('appends remaining labels in sorted key order', () => {
  const n = seriesName({
    name: 'rapid_mlx_suffix_decode_fallthrough_total',
    labels: { reason: 'cooldown', method: 'suffix' },
    value: 0,
  });
  assert.equal(n, 'suffix_decode_fallthrough_total{method=suffix,reason=cooldown}');
});

test('label order in the input does not change the series name', () => {
  const a = seriesName({ name: 'm', labels: { b: '2', a: '1' }, value: 0 });
  const b = seriesName({ name: 'm', labels: { a: '1', b: '2' }, value: 0 });
  assert.equal(a, b);
});

/* model is a filesystem path and family is constant per target; target_id
   carries both. Keeping them would make series names enormous and unstable
   across a weights swap. */
test('drops the model and family labels', () => {
  const n = seriesName({
    name: 'rapid_mlx_model_completion_tokens_total',
    labels: { model: '/Users/x/models--unsloth--Qwen3.6', family: 'qwen3.6' },
    value: 0,
  });
  assert.equal(n, 'model_completion_tokens_total');
});

test('dropping model still leaves genuine dimensions', () => {
  const n = seriesName({
    name: 'rapid_mlx_model_requests_total',
    labels: { model: '/Users/x/y', outcome: 'failed' },
    value: 0,
  });
  assert.equal(n, 'model_requests_total{outcome=failed}');
});

test('a real fixture sample produces a compact series name', () => {
  const s = parsePrometheus(fixture('rapid-mlx-0.13.4-after-first-request.txt'));
  const sample = findSample(s, 'rapid_mlx_model_requests_total', { outcome: 'succeeded' });
  assert.ok(sample);
  assert.equal(seriesName(sample), 'model_requests_total{outcome=succeeded}');
});

test('first observation of a series yields null, not the raw value', () => {
  const c = new CounterState();
  assert.equal(c.delta('a', 10), null);
  assert.equal(c.delta('a', 14), 4);
});

test('successive deltas are per-interval, not cumulative', () => {
  const c = new CounterState();
  c.delta('a', 0);
  assert.equal(c.delta('a', 5), 5);
  assert.equal(c.delta('a', 8), 3);
  assert.equal(c.delta('a', 8), 0);
});

/* A decrease means the process restarted. Returning a negative delta would
   render as a downward spike; returning the raw value would render as a
   lifetime total masquerading as one interval. Both are wrong. */
test('a decrease yields null and rebaselines', () => {
  const c = new CounterState();
  c.delta('a', 100);
  assert.equal(c.delta('a', 3), null);
  assert.equal(c.delta('a', 7), 4);
});

test('series are tracked independently', () => {
  const c = new CounterState();
  c.delta('a', 1);
  c.delta('b', 100);
  assert.equal(c.delta('a', 2), 1);
  assert.equal(c.delta('b', 250), 150);
});

test('reset() clears all baselines', () => {
  const c = new CounterState();
  c.delta('a', 1);
  c.reset();
  assert.equal(c.delta('a', 2), null);
});

test('detectRestart is true only when uptime goes backwards', () => {
  assert.equal(detectRestart(100, 101), false);
  assert.equal(detectRestart(100, 100), false);
  assert.equal(detectRestart(100, 3), true);
  assert.equal(detectRestart(null, 5), false); // first observation is not a restart
  assert.equal(detectRestart(100, null), false); // a failed scrape is not a restart
});
