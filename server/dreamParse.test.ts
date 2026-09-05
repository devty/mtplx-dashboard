import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog, parseDreamCommits } from './dreamParse';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dream', name), 'utf8');

test('reads a run boundary with its timestamp', () => {
  const r = parseDreamLog(fixture('completed-run.txt'));
  assert.equal(r.runs.length, 1);
  assert.equal(new Date(r.runs[0].startedAt).getFullYear(), 2026);
  assert.equal(r.runs[0].termination, 'completed');
  assert.equal(r.runs[0].exitCode, 0);
});

test('a warned run has an rc, commits, and no end timestamp', () => {
  const [run] = parseDreamLog(fixture('warned-run.txt')).runs;
  assert.equal(run.termination, 'warned');
  assert.equal(run.globalPassRc, 143);
  assert.equal(run.endedAt, null);
  assert.ok(run.committedShas.size > 0, 'commit lines should be captured');
});

test('a truncated run has no rc, no commits, no end', () => {
  const [run] = parseDreamLog(fixture('truncated-run.txt')).runs;
  assert.equal(run.termination, 'truncated');
  assert.equal(run.globalPassRc, null);
  assert.equal(run.endedAt, null);
  assert.equal(run.committedShas.size, 0);
});

test('captures the ordered source list', () => {
  const [run] = parseDreamLog(fixture('completed-run.txt')).runs;
  assert.ok(run.sources.length >= 2);
  assert.equal(run.sources[0], 'default');
});

test('parses phase marks and keeps the raw text', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Dream cycle (partial) in 1.4s:',
    '  ✓ lint        0 fix(es) applied; 335 non-fixable (informational)',
    '  - enrich_thin  cycle.enrich_thin.enabled=false (default OFF)',
    '  ! extract_facts  extract_facts skipped: 5 legacy v0.31 facts pending fence backfill',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  assert.equal(run.cycles.length, 1);
  assert.equal(run.cycles[0].durationS, 1.4);
  const marks = run.cycles[0].phases.map((p) => `${p.mark}:${p.phase}`);
  assert.deepEqual(marks, ['ran:lint', 'skipped:enrich_thin', 'noop:extract_facts']);
  assert.match(run.cycles[0].phases[0].text, /335 non-fixable/);
});

test('attaches nested item failures to their phase', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Dream cycle (partial) in 812.4s:',
    '  ! extract_atoms  extract_atoms: 124 atoms from 2/27 transcripts + 49/50 pages (1 failed)',
    '      ✗ career-ops/by-company/n8n: malformed model output: unparseable JSON array',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  const phase = run.cycles[0].phases[0];
  assert.equal(phase.failures.length, 1);
  assert.equal(phase.failures[0].slug, 'career-ops/by-company/n8n');
  assert.match(phase.failures[0].message, /unparseable JSON array/);
});

test('counts unrecognised lines instead of throwing', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '  ~ mystery_phase  something new the script started printing',
  ].join('\n');
  const r = parseDreamLog(text);
  assert.equal(r.unrecognisedCount, 1);
  assert.equal(r.runs.length, 1);
});

test('known noise lines are not counted as unrecognised', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Brain is healthy. 6 phase(s) checked in 0.5s.',
    'No stale pages — extraction is up to date.',
    '[dream-nightly:export] [export-career-ops] transformed: 421 ok',
  ].join('\n');
  assert.equal(parseDreamLog(text).unrecognisedCount, 0);
});

test('reports the byte offset of the last incomplete run', () => {
  const complete = fixture('completed-run.txt');
  const r = parseDreamLog(complete + '[dream-nightly] Sat Sep  6 07:05:06 EDT 2026 starting\n');
  assert.equal(r.lastIncompleteRunOffset, Buffer.byteLength(complete, 'utf8'));
});

test('a fully complete log has no incomplete-run offset', () => {
  const r = parseDreamLog(fixture('completed-run.txt'));
  assert.equal(r.lastIncompleteRunOffset, null);
});

test('parses dream auto-commit dates out of git log output', () => {
  const gitLog = [
    'e7fd46f 2026-09-05 dream: auto-commit gbrain writes 2026-09-05',
    'a89789a 2026-09-04 dream: auto-commit gbrain writes 2026-09-04',
    'e9f2ee5 2026-09-04 career-ops: delete stale hand-copied applications-tracker',
  ].join('\n');
  const m = parseDreamCommits(gitLog);
  assert.equal(m.get('2026-09-05'), 'e7fd46f');
  assert.equal(m.get('2026-09-04'), 'a89789a');
  assert.equal(m.size, 2, 'non-dream commits are ignored');
});

test('parses the whole real log with zero unrecognised lines', () => {
  for (const f of ['completed-run.txt', 'warned-run.txt', 'truncated-run.txt']) {
    assert.equal(parseDreamLog(fixture(f)).unrecognisedCount, 0, `${f} has unparsed lines`);
  }
});
