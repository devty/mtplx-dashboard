import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets } from './targets';

test('defaults to a single qwen target on :8000', () => {
  const t = parseTargets({});
  assert.equal(t.length, 1);
  assert.deepEqual(t[0], {
    id: 'qwen', label: 'qwen', upstreamUrl: 'http://127.0.0.1:8000', proxyPort: 8010,
  });
});

test('parses several targets with labels', () => {
  const t = parseTargets({
    RAPID_MLX_TARGETS:
      'qwen=http://127.0.0.1:8000:8010|Qwen3.6-35B-A3B,gemma=http://127.0.0.1:8087:8011|Gemma 4',
  });
  assert.equal(t.length, 2);
  assert.equal(t[1].id, 'gemma');
  assert.equal(t[1].label, 'Gemma 4');
  assert.equal(t[1].upstreamUrl, 'http://127.0.0.1:8087');
  assert.equal(t[1].proxyPort, 8011);
});

/* A bare host:port URL must not have its own port eaten as a proxy port. */
test('a URL without a proxy port yields proxyPort null', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'a=http://127.0.0.1:8000' });
  assert.equal(t[0].upstreamUrl, 'http://127.0.0.1:8000');
  assert.equal(t[0].proxyPort, null);
});

test('strips a trailing slash from the upstream URL', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'a=http://127.0.0.1:8000/' });
  assert.equal(t[0].upstreamUrl, 'http://127.0.0.1:8000');
});

test('falls back to the default when every entry is malformed', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'garbage,,=,x=' });
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'qwen');
});
