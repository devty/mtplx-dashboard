import { config } from './config';
import { broadcastTick } from './sse';
import { parsePrometheus, findSample } from './promParse';
import type { PromScrape } from './promParse';
import { seriesName, CounterState } from './promSeries';
import { RunTracker } from './runTracker';
import * as healthPoller from './healthPoller';
import type { Store } from './db';
import type { Target } from './targets';
import type { RingBuffers, StatePayload } from './types';

const rings: RingBuffers = { decode: [], prefill: [], ttft: [], accept: [] };
const counters = new CounterState();
/** Last persisted value per series, so unchanged series are not rewritten. */
const lastPersisted = new Map<string, number | null>();

let target: Target | null = null;
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

/** True for families whose stored value must be a per-interval delta. */
function isCumulative(s: PromScrape, name: string): boolean {
  if (name.endsWith('_bucket') || name.endsWith('_sum') || name.endsWith('_count')) return true;
  const base = name.replace(/_(bucket|sum|count)$/, '');
  return s.families.get(name)?.type === 'counter' || s.families.get(base)?.type === 'histogram';
}

function persistGauges(s: PromScrape, now: number): void {
  if (!store || !target) return;
  if (now - lastPersistAt < config.gaugePersistIntervalMs) return;
  lastPersistAt = now;

  for (const sample of s.samples) {
    if (!Number.isFinite(sample.value)) continue;
    const name = seriesName(sample);

    let out: number | null;
    if (isCumulative(s, sample.name)) {
      out = counters.delta(`persist:${name}`, sample.value);
      if (out === null) continue; // first sight, or a reset — no honest delta
    } else {
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
    }

    const d = deriveSamples(s, counters);
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
    upstreamOk: null,
    lastOkAt,
    lastChangeAt,
    model: runTracker?.getModel() ?? null,
    version: runTracker?.getVersion() ?? null,
    contextWindow: healthPoller.getContextWindow(),
    series: currentSeries(),
    status: healthPoller.getStatus(),
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

export function start(t: Target, s: Store): void {
  target = t;
  store = s;
  runTracker = new RunTracker({ targetId: t.id, store: s });
  stopped = false;
  void pollOnce();
}

export function stop(): void {
  stopped = true;
  if (pollTimer) clearTimeout(pollTimer);
}
