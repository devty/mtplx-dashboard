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

const DAY_MS = 86_400_000;

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

export function expectedNights(
  schedule: DreamSchedule,
  from: number,
  to: number
): NightSlot[] {
  const out: NightSlot[] = [];
  const cursor = new Date(from);
  cursor.setHours(schedule.hour, schedule.minute, 0, 0);
  /* Starting before `from` would emit a slot the caller did not ask for. */
  if (cursor.getTime() < from) cursor.setDate(cursor.getDate() + 1);

  /* Advance by calendar date, not by adding a fixed 24h in milliseconds.
   *  This is local-time deliberately (see file header): a fixed-ms step drifts
   *  by an hour across a DST transition, and the drift never self-corrects —
   *  every slot afterwards inherits it. setDate() re-derives the wall clock
   *  from the local calendar fields, so 07:05 stays 07:05 on both sides of the
   *  transition. */
  for (let t = cursor.getTime(); t <= to; cursor.setDate(cursor.getDate() + 1), t = cursor.getTime()) {
    out.push({ date: localDate(t), expectedAt: t });
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
  now: number
): DerivedNight[] {
  const byDate = new Map<string, { run: DreamRunRecord; index: number }>();
  runs.forEach((run, index) => {
    const date = localDate(run.startedAt);
    if (!byDate.has(date)) byDate.set(date, { run, index });
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

  if (runs.length === 0) return [];

  const first = Math.min(...runs.map((r) => r.startedAt));
  const slots = expectedNights(schedule, first - DAY_MS, now);

  return slots.map((slot) => {
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
}
