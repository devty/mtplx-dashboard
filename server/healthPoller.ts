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

    model = txt(h.model) ?? model;

    const info = toRunInfo(h);
    if (info && store) {
      const next = `${info.pid}:${info.startedAt}`;
      if (next !== identity || runId === null) {
        runId = store.upsertRun(info, now);
        identity = next;
      }
      store.insertGauge('active_requests', num(h.active_requests), now);
      store.insertGauge('requests_completed', num(h.requests_completed), now);
      store.insertGauge('session_bank_bytes', num(h.session_bank?.max_bytes), now);
      store.insertGauge('session_bank_entries', num(h.session_bank?.max_entries), now);
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
 *  a run exists (when MTPLX is up) before metricsPoller starts writing rows. */
export async function start(s: Store): Promise<void> {
  store = s;
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
