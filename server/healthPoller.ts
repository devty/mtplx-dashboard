import { config } from './config';
import type { Target } from './targets';

let target: Target | null = null;
let timer: NodeJS.Timeout | null = null;
let stopped = true;

let health: unknown = null;
let status: unknown = null;
let contextWindow: number | null = null;

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), config.scrapeTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function pollOnce(): Promise<void> {
  const base = target?.upstreamUrl;
  if (base) {
    /* Settled, not raced: any one endpoint failing must not blank out the
       others, and none is worth a retry at this cadence.

       /v1/models is re-read every poll rather than cached once. It describes
       the loaded weights, which cannot change while the INFERENCE process
       lives — but this poller outlives that process, and it no longer tracks
       run identity (that moved to runTracker). Caching once therefore means
       "for the dashboard's lifetime": swap weights without restarting the
       dashboard and every later run row is persisted carrying the previous
       model's context window. Not stale — wrong, and baked into the history
       history.html diffs across runs. One extra localhost request per
       healthIntervalMs is a much better trade than a cache with no
       invalidation signal. */
    const [h, s, m] = await Promise.allSettled([
      fetchJson(`${base}/health`),
      fetchJson(`${base}/v1/status`),
      fetchJson(`${base}/v1/models`),
    ]);
    if (h.status === 'fulfilled') health = h.value;
    if (s.status === 'fulfilled') status = s.value;
    /* A failed read keeps the last known value rather than nulling it — a
       transient blip should not erase a good answer. */
    if (m.status === 'fulfilled') {
      const cw = (m.value as { data?: { context_window?: unknown }[] })?.data?.[0]?.context_window;
      if (typeof cw === 'number' && Number.isFinite(cw)) contextWindow = cw;
    }
  }
  if (!stopped) timer = setTimeout(() => void pollOnce(), config.healthIntervalMs);
}

/** Awaits only the first pass. `pollOnce` reschedules itself at its own end
 *  (via `setTimeout`), so awaiting this call does not block on every future
 *  poll — just the one the caller needs to have landed before it starts
 *  something that depends on `getHealth()`/`getContextWindow()` being
 *  populated (see server.ts's startup ordering). */
export async function start(t: Target): Promise<void> {
  target = t;
  stopped = false;
  await pollOnce();
}

export function stop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}

export function getHealth(): unknown { return health; }
export function getStatus(): unknown { return status; }
export function getContextWindow(): number | null { return contextWindow; }

/** The only prefill-rate signal rapid-mlx exposes. Instantaneous and
 *  server-wide — there is no per-request prefill rate (spec section 6). */
export function getPromptTps(): number | null {
  const v = (status as { prompt_tps?: unknown })?.prompt_tps;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
