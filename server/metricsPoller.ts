import { config } from './config';
import { broadcastTick } from './sse';
import type {
  MetricsRecord,
  MtplxMetricsResponse,
  RingBuffers,
  LogEntry,
  StatePayload,
  ToolParseCounters,
} from './types';

/* ================================================================= state
   Ported from the client-side rings/seen/order state that used to live in
   index.html and log.html — now the single source of truth for both pages. */
const rings: RingBuffers = { decode: [], prefill: [], ttft: [], accept: [] };
const logSeen = new Map<string, LogEntry>();
const logOrder: string[] = []; // request_ids, newest-first

let latest: MetricsRecord | null = null;
let toolParseCounters: ToolParseCounters | null = null;
let lastSig: string | null = null;
let lastChangeAt: number | null = null;
let lastOkAt: number | null = null;
let connected = false;
let seeded = false;
let consecutiveFailures = 0;
let model: string | null = null;

let pollTimer: NodeJS.Timeout | null = null;
let modelTimer: NodeJS.Timeout | null = null;
let stopped = true;

/* ================================================================= helpers
   sig()/sample()/pushRing() mirror index.html's former sig()/sample()/push();
   ingestLog() mirrors log.html's former ingest() (dedup + trim only — the
   DOM-node bookkeeping half of the old client ingest() stays client-side). */
function sum(a?: number[]): number {
  return (a || []).reduce((x, y) => x + (y || 0), 0);
}

function sig(m: MetricsRecord | null | undefined): string | null {
  if (!m) return null;
  return [m.session_id, m.request_elapsed_s, m.prompt_tokens, m.completion_tokens, m.ttft_s].join('|');
}

function sample(m: MetricsRecord) {
  const drafted = sum(m.drafted_by_depth);
  return {
    decode: (m.display_decode_tok_s ?? m.decode_tok_s ?? null) as number | null,
    prefill: (m.prefill_tok_s ?? m.prompt_tps ?? null) as number | null,
    ttft: (m.ttft_s ?? null) as number | null,
    accept: drafted > 0 ? sum(m.accepted_by_depth) / drafted : null,
  };
}

function pushRing(ring: (number | null)[], v: number | null): void {
  ring.push(v);
  if (ring.length > config.ringSize) ring.shift();
}

function pushSample(m: MetricsRecord): void {
  const s = sample(m);
  pushRing(rings.decode, s.decode);
  pushRing(rings.prefill, s.prefill);
  pushRing(rings.ttft, s.ttft);
  pushRing(rings.accept, s.accept);
}

function ingestLog(recent: MetricsRecord[], now: number): string[] {
  const added: string[] = [];
  (recent || []).forEach(m => {
    const id = m.request_id;
    if (!id) return;
    const existing = logSeen.get(id);
    if (existing) {
      existing.data = m;
      return;
    }
    logSeen.set(id, { firstSeen: now, data: m });
    logOrder.unshift(id);
    added.push(id);
  });
  while (logOrder.length > config.logBufferSize) {
    const drop = logOrder.pop();
    if (drop) logSeen.delete(drop);
  }
  return added;
}

/* ================================================================= polling */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function scheduleNext(delayMs: number): void {
  if (stopped) return;
  pollTimer = setTimeout(() => void pollOnce(), delayMs);
}

async function pollOnce(): Promise<void> {
  const now = Date.now();
  try {
    const res = await fetchWithTimeout(`${config.mtplxUrl}/metrics`, config.mtplxTimeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as MtplxMetricsResponse;
    const m = data.latest ?? null;
    const wasConnected = connected;
    let changed = false;

    if (!seeded) {
      /* seed history from MTPLX's own rolling window, oldest→newest, same as
         the old client-side seeding logic in index.html's poll(). */
      const rec = data.recent || [];
      rec.forEach(pushSample);
      const newSig = sig(m);
      if (m && (!rec.length || sig(rec[rec.length - 1]) !== newSig)) pushSample(m);
      seeded = true;
      lastSig = newSig;
      changed = true;
    } else {
      const newSig = sig(m);
      if (newSig !== lastSig) {
        if (m) pushSample(m);
        lastSig = newSig;
        lastChangeAt = now;
        changed = true;
      }
    }

    latest = m ?? latest;
    toolParseCounters = data.tool_parse_counters ?? toolParseCounters;

    const newLogIds = ingestLog(data.recent || [], now);
    if (newLogIds.length) changed = true;

    lastOkAt = now;
    connected = true;
    consecutiveFailures = 0;
    if (!wasConnected) changed = true; // reconnection is always broadcast-worthy

    if (changed) broadcastTick(getSnapshot());
    scheduleNext(config.pollIntervalMs);
  } catch {
    consecutiveFailures++;
    const wasConnected = connected;
    connected = false;
    if (wasConnected) broadcastTick(getSnapshot()); // announce the outage immediately
    const backoff = Math.min(
      config.maxBackoffMs,
      config.pollIntervalMs * 2 ** Math.min(consecutiveFailures, 5)
    );
    scheduleNext(backoff);
  }
}

/* Mirrors index.html's former fetchModel(): low-frequency, independent of the
   metrics poll loop, only broadcasts when the model id actually changes. */
async function pollModelOnce(): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${config.mtplxUrl}/v1/models`, config.mtplxTimeoutMs);
    const j = (await res.json()) as { data?: { id?: string }[] };
    const id = j?.data?.[0]?.id;
    if (id && id !== model) {
      model = id;
      broadcastTick(getSnapshot());
    }
  } catch {
    /* retry on the fixed interval below regardless of outcome */
  } finally {
    if (!stopped) modelTimer = setTimeout(() => void pollModelOnce(), 5000);
  }
}

/* ================================================================= public API */
export function getSnapshot(): StatePayload {
  return {
    connected,
    lastOkAt,
    lastChangeAt,
    model,
    latest,
    toolParseCounters,
    rings: {
      decode: [...rings.decode],
      prefill: [...rings.prefill],
      ttft: [...rings.ttft],
      accept: [...rings.accept],
    },
    log: {
      order: [...logOrder],
      entries: Object.fromEntries(logSeen),
    },
    ringSize: config.ringSize,
    logBufferSize: config.logBufferSize,
  };
}

export function start(): void {
  stopped = false;
  void pollOnce();
  void pollModelOnce();
}

export function stop(): void {
  stopped = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (modelTimer) clearTimeout(modelTimer);
}
