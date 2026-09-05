/** The only dream module that touches the outside world: reads the log file,
 *  shells `git log` in the brain repo, and writes through the store.
 *
 *  Everything it calls is pure, so the interesting logic is testable without a
 *  filesystem and this file stays thin enough to read in one sitting. */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseDreamLog, parseDreamCommits } from './dreamParse';
import { attributeRun } from './dreamAttribute';
import { parseSchedule, deriveNights, localDate } from './dreamSchedule';
import type { Store, DreamCommitSource } from './db';

export interface DreamIngestOptions {
  store: Store;
  logPath: string;
  plistPath: string;
  /** Brain repo for the commit cross-check. null disables it — which yields
   *  `unavailable`, never `none`. */
  brainDir: string | null;
}

export interface DreamIngestResult {
  ok: boolean;
  error: string | null;
  runsIngested: number;
  unrecognisedCount: number;
  scheduleKnown: boolean;
}

export interface DreamIngest {
  run(now?: number): DreamIngestResult;
}

function readCommits(brainDir: string | null): Map<string, string> | null {
  if (!brainDir) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', brainDir, 'log', '--format=%h %ad %s', '--date=short', '-n', '400'],
      { encoding: 'utf8', timeout: 10_000 }
    );
    return parseDreamCommits(out);
  } catch {
    /* A missing repo, a missing git, or a timeout are all "could not check".
       Returning null keeps that distinct from "checked and found nothing". */
    return null;
  }
}

function readSchedule(plistPath: string) {
  try {
    return parseSchedule(fs.readFileSync(plistPath, 'utf8'));
  } catch {
    return null;
  }
}

class Ingest implements DreamIngest {
  constructor(private readonly o: DreamIngestOptions) {}

  run(now: number = Date.now()): DreamIngestResult {
    const { store, logPath } = this.o;
    let text: string;
    let baseOffset = store.dreamIngestOffset();

    try {
      const fd = fs.openSync(logPath, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        /* A shrunken file means it was rotated or truncated; the stored offset
           is meaningless, so start over rather than reading from the middle. */
        if (baseOffset > size) baseOffset = 0;
        const length = size - baseOffset;
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, baseOffset);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        runsIngested: 0,
        unrecognisedCount: 0,
        scheduleKnown: false,
      };
    }

    const parsed = parseDreamLog(text);
    const commits = readCommits(this.o.brainDir);
    const schedule = readSchedule(this.o.plistPath);

    for (const run of parsed.runs) attributeRun(run);

    const runIds: (number | null)[] = parsed.runs.map((run) => {
      /* Same derivation dreamSchedule uses, imported rather than repeated —
         a drifted date key would orphan nights from their runs silently. */
      const key = localDate(run.startedAt);
      const fromLog = run.committedShas.size > 0;
      const fromGit = commits?.get(key) ?? null;

      let source: DreamCommitSource;
      if (commits === null) source = 'unavailable';
      else if (fromLog && fromGit) source = 'both';
      else if (fromLog) source = 'log';
      else if (fromGit) source = 'git';
      else source = 'none';

      return store.insertDreamRun(run, fromGit, source);
    });

    for (const night of deriveNights(parsed.runs, schedule, now)) {
      const id = night.runIndex === null ? null : runIds[night.runIndex] ?? null;
      store.upsertDreamNight(night.date, night.expectedAt, id, night.status);
    }

    /* Rewind to the last unterminated run so it is re-read next pass; a run
       that was `running` when we parsed it would otherwise be frozen in that
       state forever. */
    const consumed =
      parsed.lastIncompleteRunOffset !== null
        ? baseOffset + parsed.lastIncompleteRunOffset
        : baseOffset + Buffer.byteLength(text, 'utf8');
    store.setDreamIngestOffset(consumed);

    return {
      ok: true,
      error: null,
      runsIngested: parsed.runs.length,
      unrecognisedCount: parsed.unrecognisedCount,
      scheduleKnown: schedule !== null,
    };
  }
}

export function createDreamIngest(o: DreamIngestOptions): DreamIngest {
  return new Ingest(o);
}
