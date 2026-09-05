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

export interface DreamService {
  nights(limit: number): DreamNightsPayload;
  night(date: string): DreamNightDetail | null;
}

export function createDreamService(store: Store, env: NodeJS.ProcessEnv = process.env): DreamService {
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
    const now = Date.now();
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
    night(date: string): DreamNightDetail | null {
      refresh();
      return store.getDreamNight(date);
    },
  };
}
