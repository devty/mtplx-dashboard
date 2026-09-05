import type { PromSample } from './promParse';

/** Labels dropped from stored series names. `model` is a full filesystem
 *  snapshot path (enormous, and it changes on a weights swap without the
 *  series meaning anything different); `family` is constant per target. The
 *  target_id column already carries both. Every other label is a real
 *  dimension and is kept. */
const DROPPED_LABELS = new Set(['model', 'family']);

const PREFIX = 'rapid_mlx_';

/** Percent-encodes the four characters that carry structure in a series name,
 *  plus `%` itself so the encoding is reversible.
 *
 *  Prometheus label values are free-form strings: nothing stops a future
 *  rapid-mlx version emitting `reason="a,b"`. Unencoded, `{a=x,b=y}` and
 *  `{a="x,b=y"}` collapse to the identical key, and because these strings are
 *  persisted, two unrelated series would merge into one history that can never
 *  be separated again. Encoding is free here and impossible to retrofit once
 *  rows exist. */
function encodeLabelValue(v: string): string {
  return v.replace(/[%,={}]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Stable DB key for a sample. Label keys are sorted so the same sample always
 *  produces the same string regardless of scrape ordering — these strings are
 *  persisted, so instability would fragment history into parallel series. */
export function seriesName(sample: PromSample): string {
  const base = sample.name.startsWith(PREFIX)
    ? sample.name.slice(PREFIX.length)
    : sample.name;

  const keys = Object.keys(sample.labels)
    .filter(k => !DROPPED_LABELS.has(k))
    .sort();
  if (!keys.length) return base;

  const parts = keys.map(k => `${k}=${encodeLabelValue(sample.labels[k])}`);
  return `${base}{${parts.join(',')}}`;
}

/** Per-interval deltas over cumulative counters.
 *
 *  Returns null in the two cases where no honest delta exists: the first
 *  observation of a series (no baseline), and a decrease (the process
 *  restarted, so the counter rebased). Callers persist null rather than
 *  substituting a value — the renderers already show an em-dash for null. */
export class CounterState {
  private prev = new Map<string, number>();

  delta(series: string, value: number): number | null {
    const last = this.prev.get(series);
    this.prev.set(series, value);
    if (last === undefined) return null;
    if (value < last) return null; // counter reset
    return value - last;
  }

  reset(): void {
    this.prev.clear();
  }
}

/** A decrease in uptime_seconds is the restart signal — rapid-mlx exposes no
 *  pid or start timestamp, so this is the only exact one available. */
export function detectRestart(
  prevUptimeS: number | null,
  uptimeS: number | null
): boolean {
  if (prevUptimeS === null || uptimeS === null) return false;
  return uptimeS < prevUptimeS;
}
