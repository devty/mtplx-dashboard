import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './db';
import { createDreamService } from './dreamService';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-svc-'));
  fs.writeFileSync(
    path.join(dir, 'dream.log'),
    ['[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
     '[dream-nightly] Sat Sep  5 08:00:00 EDT 2026 done (dream exit=0)', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'agent.plist'),
    `<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict></dict></plist>`
  );
  const store = createStore({
    path: path.join(dir, 'history.db'),
    enabled: true,
    retentionDays: 90,
    transcriptRetentionDays: 7,
  });
  const env = {
    GBRAIN_LOG_PATH: path.join(dir, 'dream.log'),
    GBRAIN_DREAM_PLIST: path.join(dir, 'agent.plist'),
    /* Must be set. The default is ~/mybrain, which on a developer's machine is
       a real git repo — leaving this unset makes the git cross-check shell out
       against their actual brain and the assertions move with their commit
       history. Pointing at a non-repo pins commit_source to 'unavailable';
       the 'git' and 'both' paths are covered by dreamIngest's own tests. */
    GBRAIN_BRAIN_DIR: path.join(dir, 'not-a-repo'),
  } as NodeJS.ProcessEnv;
  return { store, env, dir };
}

test('serves nights and reports ingest status', () => {
  const { store, env } = harness();
  const svc = createDreamService(store, env);
  const payload = svc.nights(14);
  assert.equal(payload.status.ok, true);
  assert.ok(payload.nights.length >= 1);
  store.close();
});

test('a broken log degrades to an error payload, never throws', () => {
  const { store, env } = harness();
  const svc = createDreamService(store, { ...env, GBRAIN_LOG_PATH: '/nonexistent/x.log' });
  const payload = svc.nights(14);
  assert.equal(payload.status.ok, false);
  assert.ok(payload.status.error);
  assert.deepEqual(payload.nights, []);
  store.close();
});

test('night detail returns null for an unknown date', () => {
  const { store, env } = harness();
  assert.equal(createDreamService(store, env).night('1999-01-01'), null);
  store.close();
});
