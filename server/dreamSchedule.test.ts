import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog } from './dreamParse';
import { parseSchedule, expectedNights, deriveNights, localDate } from './dreamSchedule';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'dream', name), 'utf8');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.gbrain.dream-nightly</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>5</integer></dict>
</dict></plist>`;

test('reads hour and minute out of the plist', () => {
  assert.deepEqual(parseSchedule(PLIST), { hour: 7, minute: 5 });
});

test('an unreadable plist yields null, never a default', () => {
  assert.equal(parseSchedule('<plist><dict></dict></plist>'), null);
  assert.equal(parseSchedule('not xml at all'), null);
});

test('expected nights are one per day at the scheduled time', () => {
  const from = Date.parse('2026-09-01T00:00:00');
  const to = Date.parse('2026-09-03T23:59:59');
  const slots = expectedNights({ hour: 7, minute: 5 }, from, to);
  assert.deepEqual(slots.map((s) => s.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(new Date(slots[0].expectedAt).getHours(), 7);
  assert.equal(new Date(slots[0].expectedAt).getMinutes(), 5);
});

/** The DST assertions are meaningless under a zone that has no DST: they pass
 *  against a fixed-24h-millisecond generator too. Pin the zone so the test
 *  measures what it claims to, on any machine and in CI. Node re-reads
 *  process.env.TZ, so this takes effect for Date built afterwards. */
function inZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

for (const [tz, label] of [
  ['America/New_York', 'fall back'],
  ['Europe/Berlin', 'CET/CEST'],
] as const) {
  test(`the scheduled hour survives a DST transition (${tz}, ${label})`, () => {
    inZone(tz, () => {
      // A slot generator that advances by adding a fixed 24h in milliseconds
      // drifts the wall-clock hour by one across the transition, and the drift
      // never self-corrects. Local calendar-date arithmetic (setDate) does not.
      const from = Date.parse('2026-10-24T00:00:00');
      const to = Date.parse('2026-11-03T23:59:59');
      const slots = expectedNights({ hour: 7, minute: 5 }, from, to);
      assert.equal(slots.length, 11);
      assert.equal(slots[0].date, '2026-10-24');
      assert.equal(slots.at(-1)?.date, '2026-11-03');
      for (const slot of slots) {
        assert.equal(new Date(slot.expectedAt).getHours(), 7, `${slot.date} drifted off 07:xx`);
        assert.equal(new Date(slot.expectedAt).getMinutes(), 5, `${slot.date} drifted off xx:05`);
      }
    });
  });
}

test('the window starts on the day containing `from`, however late in it', () => {
  /* A run always starts AFTER its scheduled second, so a window anchored on a
     run's raw timestamp must still yield that run's own night. Skipping it (the
     old clamp) reported the run's own night missed; the fixed one-day lookback
     that masked it invented a claim about a night the log never covered. */
  const from = Date.parse('2026-09-03T07:05:06');
  const to = Date.parse('2026-09-04T23:00:00');
  const slots = expectedNights({ hour: 7, minute: 5 }, from, to);
  assert.deepEqual(slots.map((s) => s.date), ['2026-09-03', '2026-09-04']);
});

test('a slot whose scheduled time has not arrived is not emitted', () => {
  const slots = expectedNights(
    { hour: 7, minute: 5 },
    Date.parse('2026-09-03T00:00:00'),
    Date.parse('2026-09-04T03:00:00')
  );
  assert.deepEqual(slots.map((s) => s.date), ['2026-09-03']);
});

test('an inverted or unparseable window yields nothing', () => {
  const sched = { hour: 7, minute: 5 };
  assert.deepEqual(expectedNights(sched, Date.parse('2026-09-05T00:00:00'), Date.parse('2026-09-01T00:00:00')), []);
  assert.deepEqual(expectedNights(sched, NaN, Date.parse('2026-09-05T00:00:00')), []);
});

test('a night with no run is missed', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const now = Date.parse('2026-09-05T12:00:00');
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, now);

  const byDate = new Map(nights.map((n) => [n.date, n]));
  assert.equal(byDate.get('2026-09-03')?.status, 'missed');
  assert.equal(byDate.get('2026-09-04')?.status, 'missed');
  assert.equal(byDate.get('2026-09-03')?.runIndex, null);
});

test('a night with a run takes that run status', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, Date.parse('2026-09-05T12:00:00'));
  const sep5 = nights.find((n) => n.date === '2026-09-05');
  assert.ok(sep5);
  assert.notEqual(sep5.status, 'missed');
  assert.equal(typeof sep5.runIndex, 'number');
});

test('NO SCHEDULE MEANS NO MISSED CLAIMS', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const nights = deriveNights(runs, null, Date.parse('2026-09-05T12:00:00'));
  assert.equal(nights.some((n) => n.status === 'missed'), false);
  assert.equal(nights.length, runs.length, 'only nights that actually ran');
});

test('today is not marked missed before its scheduled time', () => {
  const runs = parseDreamLog(fixture('missed-gap.txt')).runs;
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, Date.parse('2026-09-06T03:00:00'));
  assert.equal(nights.find((n) => n.date === '2026-09-06'), undefined);
});

test('the derived window never reaches behind the evidence it was given', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, Date.parse('2026-09-05T12:00:00'));
  const first = Math.min(...runs.map((r) => r.startedAt));
  assert.equal(nights[0].date, localDate(first), 'no claim about a night before the first run');
});

test('an explicit window bound overrides the runs, and clips the claims to it', () => {
  const { runs } = parseDreamLog(fixture('missed-gap.txt'));
  const now = Date.parse('2026-09-05T12:00:00');
  const tail = runs.slice(-1); // what a rewind pass actually sees
  const nights = deriveNights(tail, { hour: 7, minute: 5 }, now, tail[0].startedAt);
  assert.deepEqual(
    nights.map((n) => n.date),
    [localDate(tail[0].startedAt)],
    'a tail pass must not restate the nights it did not parse'
  );
});

test('the latest attempt wins when one night ran twice', () => {
  // Zone-pinned: the fixture timestamps are EDT, and far enough east the two
  // attempts straddle local midnight and stop being the same night at all.
  inZone('America/New_York', () => {
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] Sat Sep  5 07:06:00 EDT 2026 done (dream exit=0)',
    '[dream-nightly] Sat Sep  5 09:00:00 EDT 2026 starting',
    'Dream cycle (ok) in 1.0s:',
  ].join('\n');
  const { runs } = parseDreamLog(text);
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, Date.parse('2026-09-05T12:00:00'));
  const sep5 = nights.find((n) => n.date === '2026-09-05');
  assert.equal(sep5?.runIndex, 1, 'the retry, not the first attempt');
  assert.equal(sep5?.status, 'truncated');
  });
});

test('a run recorded ahead of the clock is still reported, not suppressed', () => {
  /* The schedule walk stops at `now` so tonight is not called missed before it
     is due. That guard must never suppress a night we have evidence for. */
  const text = [
    '[dream-nightly] Sat Sep  5 07:05:06 EDT 2026 starting',
    '[dream-nightly] Sat Sep  5 07:06:00 EDT 2026 done (dream exit=0)',
  ].join('\n');
  const { runs } = parseDreamLog(text);
  const nights = deriveNights(runs, { hour: 7, minute: 5 }, runs[0].startedAt - 3_600_000);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].status, 'ok');
  assert.equal(nights[0].runIndex, 0);
});
