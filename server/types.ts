import type { PersistStatus } from './db';

export interface RingBuffers {
  decode: (number | null)[];
  prefill: (number | null)[];
  ttft: (number | null)[];
  accept: (number | null)[];
}

/** Single payload shape for both the initial SSE 'snapshot' and every later
 *  'tick'. Sent in full, never diffed — broadcasts only happen on genuine
 *  change, so the payload size is not the bottleneck. */
export interface StatePayload {
  targetId: string | null;
  targetLabel: string | null;
  /** Whether the last /metrics scrape succeeded. */
  scrapeOk: boolean;
  /** Capture-proxy forward-path health. Always null in Phase 1 — there is no
   *  proxy yet. The two are independent: a failed scrape says nothing about
   *  whether inference is serving. */
  upstreamOk: boolean | null;
  lastOkAt: number | null;
  lastChangeAt: number | null;
  model: string | null;
  version: string | null;
  contextWindow: number | null;
  /** Every current sample, keyed by the same series name used in the gauge
   *  table, so the client never reimplements the parser. */
  series: Record<string, number>;
  /** Raw /v1/status body, for the queue and memory cards. */
  status: unknown;
  rings: RingBuffers;
  ringSize: number;
  persist: PersistStatus;
}
