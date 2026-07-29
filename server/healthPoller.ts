import { config } from './config';
import type { Store, RunInfo } from './db';
import type { HealthResponse } from './types';

let store: Store | null = null;
let timer: NodeJS.Timeout | null = null;
let stopped = true;
let runId: number | null = null;
let model: string | null = null;
/** `${pid}:${started_at}` of the run currently believed live. */
let identity: string | null = null;
/** Invoked exactly when `model` actually changes, so callers (server.ts) can
 *  push an SSE tick without healthPoller importing metricsPoller/sse itself —
 *  that would be a real require() cycle under CommonJS. */
let onModelChange: (() => void) | null = null;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function txt(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toRunInfo(h: HealthResponse): RunInfo | null {
  const startedSec = num(h.startup?.started_at);
  if (startedSec === null) return null; // no identity available — cannot key a run
  return {
    pid: num(h.startup?.pid),
    startedAt: Math.round(startedSec * 1000), // float seconds → integer ms
    model: txt(h.model),
    runtimeMode: txt(h.runtime_mode),
    generationMode: txt(h.generation_mode),
    depth: num(h.depth),
    verifyCore: txt(h.verify_core),
    pagedKvQuantization: txt(h.paged_kv_quantization),
    contextWindow: num(h.context_window),
    health: JSON.stringify(h),
  };
}

async function pollOnce(): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${config.mtplxUrl}/health`, config.mtplxTimeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const h = (await res.json()) as HealthResponse;
    const now = Date.now();

    const newModel = txt(h.model);
    if (newModel !== null && newModel !== model) {
      model = newModel;
      onModelChange?.();
    }

    const info = toRunInfo(h);
    if (info && store) {
      const next = `${info.pid}:${info.startedAt}`;
      if (next !== identity || runId === null) {
        runId = store.upsertRun(info, now);
        identity = next;
      }
      store.insertGauge('active_requests', num(h.active_requests), now);
      store.insertGauge('requests_completed', num(h.requests_completed), now);
      /* total_nbytes/entries are actual usage; max_bytes/max_entries are the
         configured ceiling and stay flat forever — sampling the ceiling
         produced a meaningless flat-line history (verified against real
         data: 933 identical samples at 51.5 GB / 48). Series names are
         unchanged; only the source field moves. */
      store.insertGauge('session_bank_bytes', num(h.session_bank?.total_nbytes), now);
      store.insertGauge('session_bank_entries', num(h.session_bank?.entries), now);
    }
  } catch {
    /* Leave runId/model at their last known values and retry on the fixed
       interval. This loop is already low-frequency, so it needs no backoff —
       unlike metricsPoller, whose cadence is 1s. */
  } finally {
    if (!stopped) timer = setTimeout(() => void pollOnce(), config.healthIntervalMs);
  }
}

/** Resolves after the FIRST poll attempt completes, so server.ts can guarantee
 *  a run exists (when MTPLX is up) before metricsPoller starts writing rows.
 *  `onModelChangeCb`, if given, fires whenever the model string actually
 *  changes — the model chip otherwise only refreshes on the next
 *  metrics-driven tick, which can be indefinitely far away if MTPLX sits idle
 *  after a restart onto a different model. */
export async function start(s: Store, onModelChangeCb?: () => void): Promise<void> {
  store = s;
  onModelChange = onModelChangeCb ?? null;
  stopped = false;
  await pollOnce();
}

export function stop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}

export function getCurrentRunId(): number | null {
  return runId;
}

export function getModel(): string | null {
  return model;
}
