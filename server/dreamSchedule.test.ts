import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDreamLog } from './dreamParse';
import { parseSchedule, expectedNights, deriveNights } from './dreamSchedule';

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

test('the scheduled hour survives a DST transition', () => {
  // 2026-11-01 is when US clocks fall back. A slot generator that advances by
  // adding a fixed 24h in milliseconds drifts the wall-clock hour by one after
  // this date, and the drift never self-corrects. Local calendar-date
  // arithmetic (setDate) does not.
  const from = Date.parse('2026-10-31T00:00:00');
  const to = Date.parse('2026-11-03T23:59:59');
  const slots = expectedNights({ hour: 7, minute: 5 }, from, to);
  assert.deepEqual(
    slots.map((s) => s.date),
    ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']
  );
  for (const slot of slots) {
    assert.equal(new Date(slot.expectedAt).getHours(), 7, `${slot.date} drifted off 07:xx`);
    assert.equal(new Date(slot.expectedAt).getMinutes(), 5, `${slot.date} drifted off xx:05`);
  }
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
