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

/** Captures console.warn for the duration of fn. */
function captureWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return lines;
}

test('falls back to the default when every entry is malformed, and says so', () => {
  let t: ReturnType<typeof parseTargets> = [];
  const warnings = captureWarnings(() => { t = parseTargets({ RAPID_MLX_TARGETS: 'garbage,,=,x=' }); });
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'qwen');
  assert.ok(warnings.some(w => w.includes('falling back')), 'fallback was silent');
});

/* A typo in one entry of a multi-target list must not quietly start the
   dashboard against half the fleet looking perfectly healthy. */
test('a malformed entry is dropped loudly, and its valid siblings survive', () => {
  let t: ReturnType<typeof parseTargets> = [];
  const warnings = captureWarnings(() => {
    t = parseTargets({ RAPID_MLX_TARGETS: 'good=http://127.0.0.1:8000:8010,badnoequals' });
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'good');
  assert.ok(warnings.some(w => w.includes('badnoequals')), 'skipped entry was not reported');
});

/* Port 0 is falsy, so a later `if (target.proxyPort)` would read an explicit
   :0 as "no proxy configured" — a config error wearing a default's clothes. */
test('an out-of-range proxy port is rejected rather than carried', () => {
  for (const bad of ['0', '99999']) {
    let t: ReturnType<typeof parseTargets> = [];
    const warnings = captureWarnings(() => {
      t = parseTargets({ RAPID_MLX_TARGETS: `a=http://127.0.0.1:8000:${bad},b=http://127.0.0.1:8087:8011` });
    });
    assert.deepEqual(t.map(x => x.id), ['b'], `proxy port ${bad} was accepted`);
    assert.ok(warnings.some(w => w.includes(bad)), `proxy port ${bad} was dropped silently`);
  }
});

test('valid boundary proxy ports are accepted', () => {
  const t = parseTargets({ RAPID_MLX_TARGETS: 'a=http://127.0.0.1:8000:1,b=http://127.0.0.1:8087:65535' });
  assert.deepEqual(t.map(x => x.proxyPort), [1, 65535]);
});
