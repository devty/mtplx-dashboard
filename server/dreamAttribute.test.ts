import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog } from './dreamParse';
import { attributeRun } from './dreamAttribute';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dream', name), 'utf8');

test('THE TRAP: a heavy block after a stamp belongs to the stamped source', () => {
  const [run] = parseDreamLog(fixture('attribution-trap.txt')).runs;
  attributeRun(run);

  const heavy = run.cycles.find((c) => c.phases.some((p) => p.phase === 'extract_atoms'));
  assert.ok(heavy, 'fixture must contain an extract_atoms block');
  assert.equal(heavy.sourceId, 'default', 'must NOT be filed under calendar');
  assert.equal(heavy.attribution, 'inferred');
});

test('a first-group block belongs to the next source stamped', () => {
  const [run] = parseDreamLog(fixture('attribution-trap.txt')).runs;
  attributeRun(run);

  const light = run.cycles.find((c) => c.phases.some((p) => p.phase === 'lint'));
  assert.ok(light);
  assert.equal(light.sourceId, 'default');
  assert.equal(light.attribution, 'stamped');
});

test('an unknown phase mix is left unattributed rather than guessed', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default calendar',
    'Dream cycle (partial) in 1.0s:',
    '  ✓ some_future_phase  invented by a later gbrain release',
    '[dream-nightly] stamped last_full_cycle_at for default',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, null);
  assert.equal(run.cycles[0].attribution, 'unknown');
});

test('a block after the final stamp still attributes to that source', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default',
    '[dream-nightly] stamped last_full_cycle_at for default',
    'Dream cycle (partial) in 9.0s:',
    '  ✓ consolidate  promoted 2 facts',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, 'default');
  assert.equal(run.cycles[0].attribution, 'inferred');
});

test('a first-group block with no stamp after it is unknown, not guessed', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default calendar',
    'Dream cycle (partial) in 1.0s:',
    '  ✓ lint  0 fix(es) applied',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, null);
  assert.equal(run.cycles[0].attribution, 'unknown');
});

test('a heavy block before any stamp in the run is unknown, not guessed', () => {
  // Symmetric to the light-branch case above, but for the heavy branch: a
  // heavy-phase block whose precedingStampIndex is -1 because no source has
  // been stamped yet anywhere in the parsed text. This is reachable in
  // production, not just a malformed-log edge case — dreamIngest parses the
  // log from a stored byte offset, so a parse can legitimately start
  // mid-run, and the first block it sees may be a heavy block with no
  // preceding stamp in the parsed text.
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] cycling sources: default calendar',
    'Dream cycle (partial) in 812.4s:',
    '  ✓ extract_atoms  found 3 atoms',
  ].join('\n');
  const [run] = parseDreamLog(text).runs;
  attributeRun(run);
  assert.equal(run.cycles[0].sourceId, null);
  assert.equal(run.cycles[0].attribution, 'unknown');
});

test('THE GLOBAL PASS IS ITS OWN ROW, NOT UNATTRIBUTED', () => {
  const [run] = parseDreamLog(fixture('completed-run.txt')).runs;
  attributeRun(run);

  const global = run.cycles.filter((c) => c.scope === 'global');
  assert.equal(global.length, 1, 'exactly one brain-wide pass per run');
  assert.equal(global[0].sourceId, null, 'it belongs to no source');
  assert.equal(global[0].attribution, 'stamped', 'the marker line states it outright');
  assert.ok(
    global[0].phases.some((p) => p.phase === 'synthesize'),
    'and it is the brain-wide block: the largest single thing in the run'
  );
});

test('every other block stays scoped to a source', () => {
  const [run] = parseDreamLog(fixture('completed-run.txt')).runs;
  attributeRun(run);
  for (const c of run.cycles) {
    if (c.scope === 'global') continue;
    assert.equal(c.scope, 'source', `block ${c.ordinal} changed scope`);
  }
});

test('the trap fixture has no global pass and none is invented', () => {
  const [run] = parseDreamLog(fixture('attribution-trap.txt')).runs;
  attributeRun(run);
  assert.equal(run.cycles.some((c) => c.scope === 'global'), false);
});
