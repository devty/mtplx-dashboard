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
  const result = createDreamService(store, env).night('1999-01-01');
  assert.equal(result.detail, null);
  assert.equal(result.status.ok, true);
  store.close();
});

/* Mirror of "a broken log degrades to an error payload, never throws" above,
   but for night() — the gap this fix closes. Before this fix, night() threw
   away the ingest status and returned bare null on both "no such night" and
   "ingest failed", so a caller (and the route) could not tell them apart. */
test('night() under a broken log reports the failure, not a bare null', () => {
  const { store, env } = harness();
  const svc = createDreamService(store, { ...env, GBRAIN_LOG_PATH: '/nonexistent/x.log' });
  const result = svc.night('2026-09-05');
  assert.equal(result.status.ok, false);
  assert.ok(result.status.error);
  assert.equal(result.detail, null);
  store.close();
});

/* The two tests below pin the 30-second cache itself — the feature this
   module and its docstring are named for. Before these, every test here
   called nights()/night() exactly once per service instance, so a
   regression that silently removed or broke the cache (e.g. flipping the
   `<` to `<=` or `>` at the comparison in dreamService.ts) would still pass
   the full suite. */

test('a cached result survives a log change within the 30s window (cache exists)', () => {
  const { store, env, dir } = harness();
  const svc = createDreamService(store, env);

  const first = svc.nights(14);
  assert.equal(first.status.ok, true);

  // Black-box probe: if the cache is live, this second call never re-reads
  // the log, so deleting it has no effect. If the cache were removed, the
  // second call would hit ENOENT and report ok:false.
  fs.unlinkSync(path.join(dir, 'dream.log'));
  const second = svc.nights(14);
  assert.equal(second.status.ok, true);
  store.close();
});

test('the cache expires after 30s and re-reads the log (cache expiry)', () => {
  const { store, env, dir } = harness();
  let t = 1_000_000;
  const svc = createDreamService(store, env, () => t);

  const first = svc.nights(14);
  assert.equal(first.status.ok, true);

  fs.unlinkSync(path.join(dir, 'dream.log'));

  // Still inside the 30s window: cache hit, deletion invisible.
  t += 29_999;
  const stillCached = svc.nights(14);
  assert.equal(stillCached.status.ok, true);

  // Past the 30s window: cache must expire and re-read the (now-missing) log.
  t += 2;
  const expired = svc.nights(14);
  assert.equal(expired.status.ok, false);
  assert.ok(expired.status.error);
  store.close();
});
