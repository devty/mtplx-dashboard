import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './db';
import { createDreamIngest } from './dreamIngest';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dream-ingest-'));
}

const PLIST = `<plist><dict><key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict>
</dict></plist>`;

const RUN = [
  '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
  '[dream-nightly] cycling sources: default',
  'Dream cycle (partial) in 1.4s:',
  '  ✓ lint  0 fix(es) applied; 335 non-fixable',
  '[dream-nightly] stamped last_full_cycle_at for default',
  '[dream-nightly] Sat Sep  5 08:00:00 EDT 2026 done (dream exit=0)',
  '',
].join('\n');

function harness(logText: string) {
  const dir = tmp();
  const logPath = path.join(dir, 'dream.log');
  const plistPath = path.join(dir, 'agent.plist');
  fs.writeFileSync(logPath, logText);
  fs.writeFileSync(plistPath, PLIST);
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: true,
    retentionDays: 90,
    transcriptRetentionDays: 7,
  });
  const ingest = createDreamIngest({ store, logPath, plistPath, brainDir: null });
  return { dir, logPath, store, ingest };
}

test('ingests a run and records the night', () => {
  const { store, ingest } = harness(RUN);
  const res = ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(res.ok, true);
  assert.equal(res.runsIngested, 1);
  assert.equal(store.queryDreamNights(10)[0].date, '2026-09-05');
  store.close();
});

test('a missing log is reported, not thrown', () => {
  const { store, ingest, logPath } = harness(RUN);
  fs.rmSync(logPath);
  const res = ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /ENOENT|no such file/i);
  store.close();
});

test('no brain dir means commit_source is unavailable, not none', () => {
  const { store, ingest } = harness(RUN);
  ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(store.getDreamNight('2026-09-05')?.run?.commitSource, 'unavailable');
  store.close();
});

test('is incremental: a second run with no new bytes ingests nothing', () => {
  const { store, ingest } = harness(RUN);
  ingest.run(Date.parse('2026-09-05T12:00:00'));
  const second = ingest.run(Date.parse('2026-09-05T12:01:00'));
  assert.equal(second.runsIngested, 0);
  store.close();
});

test('re-evaluates a run that was incomplete on the previous pass', () => {
  const incomplete = RUN.split('\n').slice(0, 5).join('\n') + '\n';
  const { store, ingest, logPath } = harness(incomplete);

  ingest.run(Date.parse('2026-09-05T07:30:00'));
  assert.equal(store.getDreamNight('2026-09-05')?.run?.termination, 'truncated');

  fs.writeFileSync(logPath, RUN); // the run finishes
  const res = ingest.run(Date.parse('2026-09-05T12:00:00'));
  assert.equal(res.runsIngested, 1, 'must rewind, not skip');
  assert.equal(store.getDreamNight('2026-09-05')?.run?.termination, 'completed');
  store.close();
});

test('offsets are byte offsets — multibyte marks do not desync ingest', () => {
  const { store, ingest, logPath } = harness(RUN);
  ingest.run(Date.parse('2026-09-05T12:00:00'));
  fs.appendFileSync(
    logPath,
    ['[dream-nightly] Sun Sep  6 07:05:06 EDT 2026 starting',
     'Dream cycle (partial) in 1.0s:',
     '  ✓ lint  ✓✓✓ — multibyte — 0 fix(es)',
     '[dream-nightly] Sun Sep  6 08:00:00 EDT 2026 done (dream exit=0)', ''].join('\n')
  );
  const res = ingest.run(Date.parse('2026-09-06T12:00:00'));
  assert.equal(res.runsIngested, 1);
  assert.equal(store.getDreamNight('2026-09-06')?.run?.termination, 'completed');
  store.close();
});

test('an unreadable plist disables missed-night claims but still ingests', () => {
  const { store, ingest, dir } = harness(RUN);
  fs.writeFileSync(path.join(dir, 'agent.plist'), 'garbage');
  const res = ingest.run(Date.parse('2026-09-08T12:00:00'));
  assert.equal(res.ok, true);
  assert.equal(res.scheduleKnown, false);
  assert.equal(store.queryDreamNights(20).some((n) => n.status === 'missed'), false);
  store.close();
});
