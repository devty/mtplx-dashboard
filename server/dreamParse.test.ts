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
  /* Every committed fixture, not a subset: the two that were skipped both parse
     clean, and missed-gap.txt is the only one carrying two runs. */
  for (const f of [
    'completed-run.txt',
    'warned-run.txt',
    'truncated-run.txt',
    'attribution-trap.txt',
    'missed-gap.txt',
  ]) {
    assert.equal(parseDreamLog(fixture(f)).unrecognisedCount, 0, `${f} has unparsed lines`);
  }
});

test('records where the global pass block starts', () => {
  const [run] = parseDreamLog(fixture('completed-run.txt')).runs;
  assert.equal(typeof run.globalPassCycleOrdinal, 'number');
  const block = run.cycles[run.globalPassCycleOrdinal as number];
  assert.ok(block, 'the marker must point at a real block');
  assert.ok(
    block.phases.some((p) => p.phase === 'synthesize'),
    'the global pass is the brain-wide block, not a source group'
  );
});

test('a run with no global pass marker records null', () => {
  const [run] = parseDreamLog(fixture('truncated-run.txt')).runs;
  assert.equal(run.globalPassCycleOrdinal, null);
});

test('an unparseable run timestamp is counted, not silently NaN', () => {
  // Date.parse knows EDT/EST/UTC/GMT and little else; CEST returns NaN. The
  // line matched the run-boundary shape, so nothing downstream would notice.
  const r = parseDreamLog(
    ['[dream-nightly] Sat Sep  5 07:05:06 CEST 2026 starting', 'Dream cycle (ok) in 1.0s:'].join('\n')
  );
  assert.equal(r.runs.length, 0, 'no run may be opened on an unreadable timestamp');
  assert.ok(r.unrecognisedCount >= 1, 'and the drift canary must see it');
});

test('an unparseable run timestamp does not attach its lines to the previous run', () => {
  const r = parseDreamLog(
    [
      '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
      'Dream cycle (ok) in 1.0s:',
      '  ✓ lint  fine',
      '[dream-nightly] Sun Sep  6 07:05:06 CEST 2026 starting',
      'Dream cycle (ok) in 2.0s:',
      '  ✓ lint  also fine',
    ].join('\n')
  );
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].cycles.length, 1, 'the orphaned block must not join run 1');
});

test('an unparseable done timestamp still completes the run', () => {
  const [run] = parseDreamLog(
    [
      '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
      '[dream-nightly] Sat Sep  5 08:00:00 CEST 2026 done (dream exit=0)',
    ].join('\n')
  ).runs;
  assert.equal(run.termination, 'completed');
  assert.equal(run.endedAt, null);
});

test('a drifted cycling-sources or stamped line trips the canary', () => {
  // These used to sit in the noise list behind their own regexes, so a format
  // change could only ever be swallowed there.
  const r = parseDreamLog(
    [
      '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
      '[dream-nightly] cycling sources = default calendar',
      '[dream-nightly] stamped last_full_cycle for default',
    ].join('\n')
  );
  assert.equal(r.unrecognisedCount, 2);
});

test('a phase-level ✗ is a failed mark, not a dropped line', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Dream cycle (partial) in 7133.4s:',
    "  ✗ patterns    pattern-detection subagent job 10701 ended 'dead'; nothing was written",
    "      [InternalError/PATTERNS_CHILD_DEAD] subagent job 10701 outcome 'dead' with zero pattern pages written",
  ].join('\n');
  const r = parseDreamLog(text);
  assert.equal(r.unrecognisedCount, 0, 'neither line may fall through to the canary');
  const [phase] = r.runs[0].cycles[0].phases;
  assert.equal(phase.mark, 'failed');
  assert.equal(phase.phase, 'patterns');
  assert.match(phase.text, /ended 'dead'/);
  assert.equal(phase.errors.length, 1);
  assert.equal(phase.errors[0].code, 'InternalError/PATTERNS_CHILD_DEAD');
  assert.match(phase.errors[0].detail, /zero pattern pages written/);
  assert.equal(phase.failures.length, 0, 'a phase abort is not an item failure');
});

test('the two ✗ indents stay unambiguous', () => {
  // Two spaces is the phase's own verdict; four-or-more is one item failing
  // inside a phase that otherwise ran. Same character, opposite meaning.
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    'Dream cycle (partial) in 249.6s:',
    '  ! extract_atoms  extract_atoms: 0 atoms from 0/50 pages (1 failed)',
    '      ✗ linkedin/messages/example: aborting phase: billing error is a whole-run condition',
    '  ✗ calibration_profile  calibration_profile failed: Not found',
  ].join('\n');
  const r = parseDreamLog(text);
  assert.equal(r.unrecognisedCount, 0);
  const [atoms, calib] = r.runs[0].cycles[0].phases;
  assert.equal(r.runs[0].cycles[0].phases.length, 2, 'the nested ✗ is not a phase');
  assert.equal(atoms.mark, 'noop');
  assert.equal(atoms.failures.length, 1);
  assert.equal(atoms.failures[0].slug, 'linkedin/messages/example');
  assert.equal(atoms.errors.length, 0);
  assert.equal(calib.mark, 'failed');
  assert.equal(calib.failures.length, 0);
});

test('an error line with no phase above it still trips the canary', () => {
  const r = parseDreamLog(
    [
      '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
      'Dream cycle (ok) in 1.0s:',
      '      [InternalError/ORPHANED] nothing declared this',
    ].join('\n')
  );
  assert.equal(r.unrecognisedCount, 1);
});

test('the real failed-phase run parses its ✗ phase and error detail', () => {
  const r = parseDreamLog(fixture('failed-phase-run.txt'));
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].termination, 'completed', 'exit=0 — a clean-looking night');
  const failed = r.runs[0].cycles
    .flatMap((c) => c.phases)
    .filter((p) => p.mark === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].phase, 'calibration_profile');
  assert.equal(failed[0].errors[0].code, 'InternalError/CALIBRATION_PROFILE_UNKNOWN');
  assert.match(failed[0].errors[0].detail, /credit balance is too low/);

  // The same run also carries nested item failures, at the other indent.
  const nested = r.runs[0].cycles.flatMap((c) => c.phases).filter((p) => p.failures.length);
  assert.ok(nested.length >= 1, 'and they are still item failures, not phases');
  assert.ok(nested.every((p) => p.mark !== 'failed'));
});
