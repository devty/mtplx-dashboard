/** The only dream module that touches the outside world: reads the log file,
 *  shells `git log` in the brain repo, and writes through the store.
 *
 *  Everything it calls is pure, so the interesting logic is testable without a
 *  filesystem and this file stays thin enough to read in one sitting. */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseDreamLog, parseDreamCommits } from './dreamParse';
import { attributeRun } from './dreamAttribute';
import { parseSchedule, deriveNights, expectedNights, localDate } from './dreamSchedule';
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

/** `since` is a `YYYY-MM-DD` local date; the window must cover every run being
 *  ingested. A fixed `-n <count>` cannot: on a real brain repo 400 commits
 *  reaches back about 72 days against a first-ingest backfill of roughly two
 *  months, and the margin shrinks as the repo grows. Once a night falls off the
 *  end, the lookup returns nothing while the check itself "succeeded", so the
 *  night is recorded `none` — "no commit" — for a night that banked work fine.
 *  That is the none/unavailable collapse spec section 7 forbids, arriving
 *  silently and in the false-alarm direction. */
function readCommits(brainDir: string | null, since: string): Map<string, string> | null {
  if (!brainDir) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', brainDir, 'log', '--format=%h %ad %s', '--date=short', `--since=${since}`],
      {
        encoding: 'utf8',
        timeout: 10_000,
        /* git's own diagnostics ("fatal: cannot change to …") are noise: every
           failure below collapses to `unavailable` regardless of the message,
           and test output must stay pristine. */
        stdio: ['ignore', 'pipe', 'ignore'],
      }
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
    let bytesRead = 0;
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
        /* readSync may return short. The buffer is allocUnsafe, so trusting the
           requested length would decode uninitialised memory into the tail. */
        let read = 0;
        while (read < length) {
          const n = fs.readSync(fd, buf, read, length - read, baseOffset + read);
          if (n <= 0) break;
          read += n;
        }
        bytesRead = read;
        text = buf.toString('utf8', 0, read);
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
    /* One day of slack: the run's local date and the commit's `--date=short`
       date can straddle midnight in either direction. */
    const oldestRun = parsed.runs.length
      ? Math.min(...parsed.runs.map((r) => r.startedAt))
      : null;
    const commits =
      oldestRun === null ? null : readCommits(this.o.brainDir, localDate(oldestRun - 86_400_000));
    const schedule = readSchedule(this.o.plistPath);

    for (const run of parsed.runs) attributeRun(run);

    const runIds: (number | null)[] = parsed.runs.map((run) => {
      /* Same derivation dreamSchedule uses, imported rather than repeated —
         a drifted date key would orphan nights from their runs silently. */
      const key = localDate(run.startedAt);
      const fromLog = run.committedShas.size > 0;
      const fromGit = commits?.get(key) ?? null;

      /* `unavailable` is the LAST resort, not the first. The log's own commit
         lines are evidence in their own right, so a night that printed one is
         `log` even when the git cross-check could not run — reporting
         "couldn't check" over a sha we hold would hide the very disagreement
         (committed but never finished) the view exists to show. */
      let source: DreamCommitSource;
      if (fromLog && fromGit) source = 'both';
      else if (fromLog) source = 'log';
      else if (fromGit) source = 'git';
      else if (commits === null) source = 'unavailable';
      else source = 'none';

      return store.insertDreamRun(run, fromGit, source);
    });

    /* The window this pass can vouch for. Ingest rewinds to the last incomplete
       run, so `parsed.runs` is a TAIL on every pass after the first — it holds
       every run from `oldestRun` forward, and nothing before it. Deriving
       nights over a wider window would emit `missed` for nights this pass never
       read, and the upsert would overwrite the correct rows an earlier pass
       wrote. */
    for (const night of deriveNights(parsed.runs, schedule, now, oldestRun)) {
      const id = night.runIndex === null ? null : runIds[night.runIndex] ?? null;
      store.upsertDreamNight(night.date, night.expectedAt, id, night.status);
    }

    /* Forward edge. When the log ends on a completed run the offset sits at
       end-of-file, so a later pass parses no runs at all and the loop above
       claims nothing — yet "last night never ran" (spec section 3) is exactly
       the case that needs claiming. Walk the schedule forward from the newest
       night already on record to now, and write ONLY where no row exists: a
       forward slot is by definition after all the evidence, and insert-if-absent
       means this can never restate a night an earlier pass settled. */
    if (schedule) {
      const latest = store.latestDreamNight();
      if (latest) {
        for (const slot of expectedNights(schedule, latest.expectedAt, now)) {
          store.insertDreamNightIfAbsent(slot.date, slot.expectedAt, 'missed');
        }
      }
    }


    /* Rewind to the last unterminated run so it is re-read next pass; a run
       that was `running` when we parsed it would otherwise be frozen in that
       state forever. */
    const consumed =
      parsed.lastIncompleteRunOffset !== null
        ? baseOffset + parsed.lastIncompleteRunOffset
        : baseOffset + bytesRead;
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
