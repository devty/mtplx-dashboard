import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrometheus, findSample } from './promParse';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const COLD = 'rapid-mlx-0.13.4-cold.txt';
const AFTER = 'rapid-mlx-0.13.4-after-first-request.txt';
const GEMMA = 'rapid-mlx-0.13.4-gemma.txt';

test('parses an unlabelled sample', () => {
  const s = parsePrometheus('# TYPE x gauge\nx 1.5\n');
  assert.equal(s.samples.length, 1);
  assert.deepEqual(s.samples[0], { name: 'x', labels: {}, value: 1.5 });
});

test('parses labels, including values containing separators', () => {
  const s = parsePrometheus('m{a="1",b="p/q--r,s"} 7\n');
  assert.deepEqual(s.samples[0].labels, { a: '1', b: 'p/q--r,s' });
  assert.equal(s.samples[0].value, 7);
});

test('unescapes backslash, quote and newline in label values', () => {
  const s = parsePrometheus('m{a="x\\\\y\\"z\\n"} 1\n');
  assert.equal(s.samples[0].labels.a, 'x\\y"z\n');
});

test('parses +Inf, -Inf and NaN values', () => {
  const s = parsePrometheus('a +Inf\nb -Inf\nc NaN\n');
  assert.equal(s.samples[0].value, Infinity);
  assert.equal(s.samples[1].value, -Infinity);
  assert.ok(Number.isNaN(s.samples[2].value));
});

test('ignores a trailing timestamp column', () => {
  const s = parsePrometheus('m 1.5 1788600000000\n');
  assert.equal(s.samples[0].value, 1.5);
});

test('records family type and help', () => {
  const s = parsePrometheus('# HELP m Some help text.\n# TYPE m counter\nm 1\n');
  assert.equal(s.families.get('m')?.type, 'counter');
  assert.equal(s.families.get('m')?.help, 'Some help text.');
});

test('tolerates blank lines and comments that are neither HELP nor TYPE', () => {
  const s = parsePrometheus('\n# something else\n\nm 1\n');
  assert.equal(s.samples.length, 1);
});

/* The family set is not fixed. These three counts are the contract: a parser
   that hardcodes a family list passes the first two and fails the third. */
test('fixture family counts differ by traffic state and by backend', () => {
  assert.equal(parsePrometheus(fixture(COLD)).families.size, 59);
  assert.equal(parsePrometheus(fixture(AFTER)).families.size, 73);
  assert.equal(parsePrometheus(fixture(GEMMA)).families.size, 80);
});

test('gemma exposes a prefix_cache_radix subsystem qwen does not', () => {
  const qwen = parsePrometheus(fixture(AFTER)).families;
  const gemma = parsePrometheus(fixture(GEMMA)).families;
  assert.equal(qwen.has('rapid_mlx_prefix_cache_radix_nodes'), false);
  assert.equal(gemma.has('rapid_mlx_prefix_cache_radix_nodes'), true);
});

/* _max and _last only exist once a request has completed. */
test('cold fixture lacks the _last gauge the warm one has', () => {
  const cold = parsePrometheus(fixture(COLD));
  const after = parsePrometheus(fixture(AFTER));
  assert.equal(findSample(cold, 'rapid_mlx_model_decode_tokens_per_second_last'), null);
  assert.equal(
    findSample(after, 'rapid_mlx_model_decode_tokens_per_second_last')?.value,
    36.726379
  );
});

/* The model label is a full filesystem path with -- separators and a 40-char
   hash. It must round-trip byte-for-byte. */
test('round-trips a filesystem-path label value', () => {
  const s = parsePrometheus(fixture(AFTER));
  const sample = findSample(s, 'rapid_mlx_model_completion_tokens_total');
  assert.ok(sample);
  assert.ok(sample.labels.model.startsWith('/Users/'));
  assert.ok(sample.labels.model.includes('models--unsloth--Qwen3.6-35B-A3B-UD-MLX-4bit'));
  assert.equal(sample.value, 9);
});

test('findSample matches on a label subset', () => {
  const s = parsePrometheus(fixture(AFTER));
  assert.equal(findSample(s, 'rapid_mlx_kv_cache_dtype', { dtype: 'bf16' })?.value, 1);
  assert.equal(findSample(s, 'rapid_mlx_kv_cache_dtype', { dtype: 'int4' })?.value, 0);
  assert.equal(findSample(s, 'rapid_mlx_kv_cache_dtype', { dtype: 'nope' }), null);
});

test('parses cumulative histogram buckets including +Inf', () => {
  const s = parsePrometheus(fixture(AFTER));
  const at = (le: string) =>
    findSample(s, 'rapid_mlx_model_ttft_seconds_bucket', { le })?.value ?? null;
  /* Buckets are cumulative. The one completed request took 0.393659s, so every
     bucket below it is 0 and every bucket from le=0.5 up carries the 1, with
     +Inf always holding the full count. */
  assert.equal(at('0.25'), 0);
  assert.equal(at('0.5'), 1);
  assert.equal(at('+Inf'), 1);
  assert.equal(findSample(s, 'rapid_mlx_model_ttft_seconds_count')?.value, 1);
});
