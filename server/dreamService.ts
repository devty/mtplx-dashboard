/** Config resolution plus a 30-second ingest cache. Exists so server.ts gains
 *  two thin routes rather than this bookkeeping. */

import os from 'node:os';
import path from 'node:path';
import { createDreamIngest, type DreamIngestResult } from './dreamIngest';
import type { Store, DreamNightRow, DreamNightDetail } from './db';

const CACHE_MS = 30_000;

export interface DreamNightsPayload {
  nights: DreamNightRow[];
  status: {
    ok: boolean;
    error: string | null;
    scheduleKnown: boolean;
    unrecognisedCount: number;
  };
}

export interface DreamNightResult {
  /** null both when ingest failed (status.ok === false — check status.error
   *  before trusting this) and when ingest succeeded but the date genuinely
   *  has no run. The route tells these apart via `status.ok`, never by the
   *  presence of `detail` alone. */
  detail: DreamNightDetail | null;
  status: DreamNightsPayload['status'];
}

export interface DreamService {
  nights(limit: number): DreamNightsPayload;
  night(date: string): DreamNightResult;
}

export function createDreamService(
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
  /** Injectable clock. Defaults to Date.now; tests pass a fake to pin the
   *  cache's 30-second expiry without sleeping or monkey-patching Date. */
  clock: () => number = Date.now
): DreamService {
  const home = os.homedir();
  const ingest = createDreamIngest({
    store,
    logPath: env.GBRAIN_LOG_PATH ?? path.join(home, '.gbrain', 'dream-nightly.log'),
    plistPath:
      env.GBRAIN_DREAM_PLIST ??
      path.join(home, 'Library', 'LaunchAgents', 'com.gbrain.dream-nightly.plist'),
    brainDir: env.GBRAIN_BRAIN_DIR ?? path.join(home, 'mybrain'),
  });

  let last: DreamIngestResult | null = null;
  let lastAt = 0;

  const refresh = (): DreamIngestResult => {
    const now = clock();
    if (last && now - lastAt < CACHE_MS) return last;
    last = ingest.run(now);
    lastAt = now;
    return last;
  };

  return {
    nights(limit: number): DreamNightsPayload {
      const res = refresh();
      return {
        nights: res.ok ? store.queryDreamNights(limit) : [],
        status: {
          ok: res.ok,
          error: res.error,
          scheduleKnown: res.scheduleKnown,
          unrecognisedCount: res.unrecognisedCount,
        },
      };
    },
    night(date: string): DreamNightResult {
      const res = refresh();
      return {
        /* Mirrors nights(): don't query the store on a failed ingest. The
           store's data isn't "wrong" in that case, but there is no reason to
           trust it as a positive answer when the thing that's supposed to
           keep it current couldn't run. */
        detail: res.ok ? store.getDreamNight(date) : null,
        status: {
          ok: res.ok,
          error: res.error,
          scheduleKnown: res.scheduleKnown,
          unrecognisedCount: res.unrecognisedCount,
        },
      };
    },
  };
}
