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
    /* Settled, not raced: /v1/status failing must not blank out a good
       /health, and neither is worth a retry at this cadence. */
    const [h, s] = await Promise.allSettled([
      fetchJson(`${base}/health`),
      fetchJson(`${base}/v1/status`),
    ]);
    if (h.status === 'fulfilled') health = h.value;
    if (s.status === 'fulfilled') status = s.value;

    /* context_window belongs to the loaded weights, so it is fetched once and
       then only re-fetched if it is still unknown. */
    if (contextWindow === null) {
      try {
        const models = (await fetchJson(`${base}/v1/models`)) as {
          data?: { context_window?: unknown }[];
        };
        const cw = models?.data?.[0]?.context_window;
        if (typeof cw === 'number' && Number.isFinite(cw)) contextWindow = cw;
      } catch {
        /* absent until the server answers; harmless */
      }
    }
  }
  if (!stopped) timer = setTimeout(() => void pollOnce(), config.healthIntervalMs);
}

export function start(t: Target): void {
  target = t;
  stopped = false;
  void pollOnce();
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
