/** Expected-night derivation. The clock is injected; there is no I/O here —
 *  the caller reads the plist and passes its text in.
 *
 *  The governing rule is in the spec (§7): never invent an alarm. A missed
 *  night is a claim, and a claim needs a schedule to be measured against. When
 *  the schedule is unknown we emit no missed nights at all rather than falling
 *  back to a hardcoded hour — that hour has moved repeatedly, and a detector
 *  keyed to a stale one manufactures false alarms, which is the exact failure
 *  this feature exists to prevent. */

import type { DreamRunRecord } from './dreamParse';
import type { DreamNightStatus } from './db';

export interface DreamSchedule {
  hour: number;
  minute: number;
}

export interface NightSlot {
  date: string;
  expectedAt: number;
}

export interface DerivedNight extends NightSlot {
  runIndex: number | null;
  status: DreamNightStatus;
}

/** `StartCalendarInterval` → hour/minute. Returns null when either key is
 *  absent or unparseable; callers must treat null as "unknown", not "default". */
export function parseSchedule(plistXml: string): DreamSchedule | null {
  const block = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plistXml);
  if (!block) return null;
  const read = (key: string): number | null => {
    const m = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(block[1]);
    return m ? Number(m[1]) : null;
  };
  const hour = read('Hour');
  const minute = read('Minute');
  if (hour === null || minute === null) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Local-time `YYYY-MM-DD`. Exported because dreamIngest keys nights by the
 *  same string: two independent derivations of it can drift, and a drifted key
 *  orphans a night from its run silently rather than loudly. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local start-of-day for `ms`, as a Date positioned on that calendar day. */
function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** One slot per LOCAL CALENDAR DAY from the day containing `from` through the
 *  day containing `to`, each at the scheduled wall-clock time.
 *
 *  The window is derived from calendar days, never from timestamp arithmetic on
 *  `from`. A run always starts a little AFTER its scheduled second, so a
 *  window anchored on a run's raw timestamp with a "skip the slot if it is
 *  before `from`" clamp would drop that run's own night and then report it
 *  missed. Anchoring on the day removes the clamp, and with it the class of bug
 *  that a fixed `- DAY_MS` lookback was masking.
 *
 *  A slot whose scheduled time has not arrived yet (`expectedAt > to`) is not
 *  emitted: tonight's dream has not failed to run until it is late. */
export function expectedNights(
  schedule: DreamSchedule,
  from: number,
  to: number
): NightSlot[] {
  const out: NightSlot[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return out;

  const cursor = startOfLocalDay(from);
  const lastDay = startOfLocalDay(to).getTime();

  /* Advance by calendar date, not by adding a fixed 24h in milliseconds. This
   *  is local-time deliberately (see file header): a fixed-ms step drifts by an
   *  hour across a DST transition, and the drift never self-corrects — every
   *  slot afterwards inherits it. setDate() re-derives the wall clock from the
   *  local calendar fields, so 07:05 stays 07:05 on both sides. */
  while (cursor.getTime() <= lastDay) {
    const at = new Date(cursor);
    at.setHours(schedule.hour, schedule.minute, 0, 0);
    const t = at.getTime();
    if (t <= to) out.push({ date: localDate(t), expectedAt: t });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

const STATUS: Record<string, DreamNightStatus> = {
  completed: 'ok',
  warned: 'warned',
  truncated: 'truncated',
  running: 'unknown',
};

export function deriveNights(
  runs: DreamRunRecord[],
  schedule: DreamSchedule | null,
  now: number,
  /** Inclusive lower bound of the window the caller can VOUCH for: the caller
   *  guarantees `runs` holds every run that started at or after this instant.
   *  Defaults to the earliest run passed in, which is what an ingest pass can
   *  honestly claim — it parsed from that run's `starting` line to end-of-file.
   *
   *  This bound is load-bearing. Ingest rewinds to the last INCOMPLETE run and
   *  re-parses forward, so on every pass after the first `runs` is only a tail.
   *  A window wider than the tail would emit `missed` for nights the pass never
   *  looked at, and the upsert would overwrite the correct rows an earlier pass
   *  wrote. Never widen it to cover history this pass did not read. */
  windowStart: number | null = null
): DerivedNight[] {
  const byDate = new Map<string, { run: DreamRunRecord; index: number }>();
  runs.forEach((run, index) => {
    /* Last attempt wins. A night that was retried has two runs; taking the
       latest keeps the answer stable across a rewind (which re-parses only the
       tail) and reports the outcome that actually stands. */
    byDate.set(localDate(run.startedAt), { run, index });
  });

  /* No schedule: report only nights we have evidence for. */
  if (!schedule) {
    return [...byDate.entries()]
      .map(([date, { run, index }]) => ({
        date,
        expectedAt: run.startedAt,
        runIndex: index,
        status: STATUS[run.termination] ?? 'unknown',
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  const from = windowStart ?? (runs.length ? Math.min(...runs.map((r) => r.startedAt)) : null);
  if (from === null) return [];

  const out: DerivedNight[] = expectedNights(schedule, from, now).map((slot) => {
    const hit = byDate.get(slot.date);
    if (hit) {
      return {
        ...slot,
        runIndex: hit.index,
        status: STATUS[hit.run.termination] ?? 'unknown',
      };
    }
    return { ...slot, runIndex: null, status: 'missed' as DreamNightStatus };
  });

  /* Evidence outranks the schedule walk. That walk stops at `now` so tonight is
     not called missed before it is due — a guard against inventing an alarm,
     which must never turn into suppressing a night we actually have a run for
     (a clock behind the log, a run recorded ahead of `now`). A date with a run
     is never "not yet due", so it is added here rather than dropped. Only
     `missed` rows come from the walk; nothing here widens the window. */
  const covered = new Set(out.map((n) => n.date));
  const floor = localDate(from);
  for (const [date, hit] of byDate) {
    if (covered.has(date) || date < floor) continue;
    out.push({
      date,
      expectedAt: hit.run.startedAt,
      runIndex: hit.index,
      status: STATUS[hit.run.termination] ?? 'unknown',
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
