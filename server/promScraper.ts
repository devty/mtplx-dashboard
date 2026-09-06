import { config } from './config';
import { broadcastTick } from './sse';
import { parsePrometheus, findSample } from './promParse';
import type { PromScrape } from './promParse';
import { seriesName, CounterState } from './promSeries';
import { RunTracker } from './runTracker';
import * as healthPoller from './healthPoller';
import type { Store } from './db';
import type { Target } from './targets';
import type { EngineJoin } from './engineJoin';
import type { RingBuffers, StatePayload } from './types';

/* These start EMPTY on every dashboard restart, and that is structural, not a
   gap to be fixed. MTPLX shipped a `recent[]` rolling window that the old
   poller seeded from, so a fresh tab got deep history instantly. A Prometheus
   scrape exposes only current values — there is no past to seed from. Depth
   rebuilds as requests complete. Do not "restore" this by synthesising points
   from counters; a fabricated history is worse than a short one. */
const rings: RingBuffers = { decode: [], prefill: [], ttft: [], accept: [] };
const counters = new CounterState();
/** Last persisted value per series, so unchanged series are not rewritten. */
const lastPersisted = new Map<string, number | null>();

let target: Target | null = null;
let join: EngineJoin | null = null;
let upstreamOk: boolean | null = null;
let lastRequestAt: number | null = null;
let store: Store | null = null;
let runTracker: RunTracker | null = null;
let scrape: PromScrape | null = null;
let scrapeOk = false;
let lastOkAt: number | null = null;
let lastChangeAt: number | null = null;
let lastPersistAt = 0;
let consecutiveFailures = 0;
let pollTimer: NodeJS.Timeout | null = null;
let stopped = true;

function pushRing(ring: (number | null)[], v: number | null): void {
  ring.push(v);
  if (ring.length > config.ringSize) ring.shift();
}

function value(s: PromScrape, name: string): number | null {
  const found = findSample(s, name);
  return found && Number.isFinite(found.value) ? found.value : null;
}

/** Per-interval derivations for the sparkline rings. Pure over (scrape,
 *  counters); `counters` is mutated, which is what makes successive calls
 *  produce deltas. Exported for testing. */
export function deriveSamples(
  s: PromScrape,
  c: CounterState
): { decode: number | null; ttft: number | null; completedDelta: number | null } {
  const processed = value(s, 'rapid_mlx_requests_processed_total');
  const completedDelta = processed === null ? null : c.delta('_processed', processed);

  const sum = value(s, 'rapid_mlx_model_ttft_seconds_sum');
  const count = value(s, 'rapid_mlx_model_ttft_seconds_count');
  const dSum = sum === null ? null : c.delta('_ttft_sum', sum);
  const dCount = count === null ? null : c.delta('_ttft_count', count);

  /* No completed request in this interval means _last still holds the previous
     one; re-sampling it would fill the sparkline with duplicates. */
  const advanced = completedDelta !== null && completedDelta > 0;

  return {
    completedDelta,
    decode: advanced ? value(s, 'rapid_mlx_model_decode_tokens_per_second_last') : null,
    ttft: dSum !== null && dCount !== null && dCount > 0 ? dSum / dCount : null,
  };
}

/** True for families whose stored value must be a per-interval delta.
 *
 *  The DECLARED type decides whenever there is one — never the name. Suffix
 *  sniffing looks equivalent and is not: rapid-mlx already ships gauges whose
 *  names end in a counter-ish suffix (`..._seconds_max`, `..._per_second_last`),
 *  and a future gauge named `..._count` would be silently differenced into
 *  nonsense by a name-first rule.
 *
 *  Only a name with NO type line of its own falls through, which in this format
 *  means a histogram component (`_bucket`/`_sum`/`_count` carry no TYPE line —
 *  their parent family does). Those are cumulative exactly when that parent is
 *  a histogram. */
export function isCumulative(s: PromScrape, name: string): boolean {
  const declared = s.families.get(name)?.type;
  if (declared) return declared === 'counter';
  const base = name.replace(/_(bucket|sum|count)$/, '');
  return s.families.get(base)?.type === 'histogram';
}

/** What a cumulative counter's sample contributes to the gauge table: a rate
 *  per second, not the raw delta. `persistGauges` is only reachable from
 *  `pollOnce`'s success path, so the real gap between two persists is
 *  `config.gaugePersistIntervalMs` only when nothing goes wrong — under
 *  scrape backoff or any outage it can run arbitrarily longer, and a raw
 *  delta stored across that longer gap lands in the exact same `gauge.series`
 *  column as the normal-cadence deltas, with no duration recorded anywhere to
 *  tell them apart. `queryGauges` then averages a 10 s delta and a 30 s delta
 *  together as if they were the same unit, which reads as a traffic spike (or
 *  dip) that never happened, and changing `GAUGE_PERSIST_INTERVAL_MS` would
 *  silently rescale every value persisted before the change. A rate is stable
 *  regardless of cadence, so this divides the delta by the true elapsed time
 *  rather than the assumed one.
 *
 *  Returns null when there is no honest value to store: `delta` is already
 *  null for a counter's first sighting or a reset (see `CounterState.delta`),
 *  and `elapsedMs <= 0` guards a zero or negative gap (clock skew, or two
 *  calls landing on the same millisecond) that would otherwise divide by zero
 *  or invert the sign. */
export function cumulativeRate(delta: number | null, elapsedMs: number): number | null {
  if (delta === null || elapsedMs <= 0) return null;
  return (delta / elapsedMs) * 1000;
}

function persistGauges(s: PromScrape, now: number): void {
  if (!store || !target) return;
  if (now - lastPersistAt < config.gaugePersistIntervalMs) return;
  /* The TRUE elapsed time since the last persist, read before it's
     overwritten below — this is what makes cumulativeRate() unit-stable
     under backoff (see its comment), as opposed to assuming every call is
     exactly gaugePersistIntervalMs apart. */
  const elapsedMs = now - lastPersistAt;
  lastPersistAt = now;

  for (const sample of s.samples) {
    if (!Number.isFinite(sample.value)) continue;
    const name = seriesName(sample);

    let out: number | null;
    if (isCumulative(s, sample.name)) {
      const delta = counters.delta(`persist:${name}`, sample.value);
      out = cumulativeRate(delta, elapsedMs);
      if (out === null) continue; // first sight, a reset, or no honest elapsed window
    } else {
      // Gauges (non-cumulative) are stored as their raw instantaneous value.
      out = sample.value;
    }

    /* Most of these sit at a constant (usually zero) forever. Writing them
       every interval would be ~74 rows/persist for no information. */
    if (lastPersisted.get(name) === out) continue;
    lastPersisted.set(name, out);
    store.insertGauge(target.id, name, out, now);
  }

  const promptTps = healthPoller.getPromptTps();
  if (promptTps !== null && lastPersisted.get('prompt_tps') !== promptTps) {
    lastPersisted.set('prompt_tps', promptTps);
    store.insertGauge(target.id, 'prompt_tps', promptTps, now);
  }
}

async function pollOnce(): Promise<void> {
  const now = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), config.scrapeTimeoutMs);
    let text: string;
    try {
      const res = await fetch(`${target!.upstreamUrl}/metrics`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(t);
    }

    const s = parsePrometheus(text);
    const wasOk = scrapeOk;
    scrape = s;

    runTracker?.observe(s, healthPoller.getHealth(), healthPoller.getContextWindow(), now);
    /* A restart rebases every counter at once; dropping the baselines wholesale
       is cheaper and safer than letting 80 series each discover it separately. */
    if (runTracker?.didRestart()) {
      counters.reset();
      lastPersisted.clear();
      /* Waiters registered before the restart belong to the dead process. */
      join?.abandon();
    }

    const d = deriveSamples(s, counters);
    /* Settle only on a successful scrape — settling on failure would age
       waiters out during an outage that has nothing to do with them. The
       wall-clock fallback in EngineJoin covers that case instead. */
    join?.settle(d.completedDelta, { ttftS: d.ttft, decodeTokS: d.decode });
    let changed = false;
    if (d.decode !== null || d.ttft !== null) {
      pushRing(rings.decode, d.decode);
      pushRing(rings.ttft, d.ttft);
      pushRing(rings.prefill, healthPoller.getPromptTps());
      pushRing(rings.accept, value(s, 'rapid_mlx_spec_decode_accept_ratio'));
      lastChangeAt = now;
      changed = true;
    }

    persistGauges(s, now);

    lastOkAt = now;
    scrapeOk = true;
    consecutiveFailures = 0;
    if (!wasOk) changed = true; // reconnection is always broadcast-worthy

    if (changed) broadcastTick(getSnapshot());
    scheduleNext(config.pollIntervalMs);
  } catch {
    consecutiveFailures++;
    const wasOk = scrapeOk;
    scrapeOk = false;
    if (wasOk) broadcastTick(getSnapshot()); // announce the outage immediately
    scheduleNext(
      Math.min(config.maxBackoffMs, config.pollIntervalMs * 2 ** Math.min(consecutiveFailures, 5))
    );
  }
}

function scheduleNext(delayMs: number): void {
  if (stopped) return;
  pollTimer = setTimeout(() => void pollOnce(), delayMs);
}

/** Flattened current values, keyed by series name, for the client to render
 *  without reimplementing the parser. */
function currentSeries(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!scrape) return out;
  for (const s of scrape.samples) {
    if (Number.isFinite(s.value)) out[seriesName(s)] = s.value;
  }
  return out;
}

export function getSnapshot(): StatePayload {
  return {
    targetId: target?.id ?? null,
    targetLabel: target?.label ?? null,
    scrapeOk,
    /* Phase 1 has no proxy, so there is nothing to report about the forward
       path. Phase 2 replaces this with the real listener state. */
    upstreamOk,
    lastOkAt,
    lastChangeAt,
    model: runTracker?.getModel() ?? null,
    version: runTracker?.getVersion() ?? null,
    contextWindow: healthPoller.getContextWindow(),
    series: currentSeries(),
    status: healthPoller.getStatus(),
    lastRequestAt,
    rings: {
      decode: [...rings.decode],
      prefill: [...rings.prefill],
      ttft: [...rings.ttft],
      accept: [...rings.accept],
    },
    ringSize: config.ringSize,
    persist: store ? store.status() : { enabled: false, ok: true, lastError: null },
  };
}

export function setUpstreamOk(ok: boolean): void {
  if (ok === upstreamOk) return;
  upstreamOk = ok;
  broadcastTick(getSnapshot());
}

export function noteRequest(ts: number): void {
  lastRequestAt = ts;
  broadcastTick(getSnapshot());
}

export function start(t: Target, s: Store, j?: EngineJoin): void {
  join = j ?? null;
  target = t;
  store = s;
  runTracker = new RunTracker({ targetId: t.id, store: s });
  stopped = false;
  void pollOnce();
}

export function getRunId(): number | null {
  return runTracker?.getRunId() ?? null;
}

export function stop(): void {
  join?.abandon();
  stopped = true;
  if (pollTimer) clearTimeout(pollTimer);
}
