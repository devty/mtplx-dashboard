import { parseTargets } from './targets';

function str(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

export const config = Object.freeze({
  targets: parseTargets(process.env),
  port: int('PORT', 8123),
  pollIntervalMs: int('POLL_INTERVAL_MS', 1000),
  /** Scrape budget only. Deliberately NOT reused for the Phase 2 forward path:
   *  gbrain does not time out local inference (see its
   *  test/ai/local-fetch-no-timeout.test.ts) and a cold-cache 35B MoE can run
   *  for minutes. See spec section 7. */
  scrapeTimeoutMs: int('SCRAPE_TIMEOUT_MS', 2500),
  ringSize: int('RING_SIZE', 120),
  logBufferSize: int('LOG_BUFFER_SIZE', 300),
  maxBackoffMs: int('MAX_BACKOFF_MS', 10000),
  dbPath: str('DB_PATH', 'data/history.db'),
  persistEnabled: bool('PERSIST_ENABLED', true),
  retentionDays: int('RETENTION_DAYS', 30),
  transcriptRetentionDays: int('TRANSCRIPT_RETENTION_DAYS', 7),
  pruneIntervalMs: int('PRUNE_INTERVAL_MS', 3600000),
  healthIntervalMs: int('HEALTH_INTERVAL_MS', 5000),
  /** Gauges persist far slower than they are scraped — see Task 7. */
  gaugePersistIntervalMs: int('GAUGE_PERSIST_INTERVAL_MS', 10000),
  /** Escape hatch: false unbinds every proxy listener and returns the dashboard
   *  to scrape-only behaviour without a code change. */
  captureEnabled: bool('CAPTURE_ENABLED', true),
  /** Per-field cap on stored transcript bodies. Counted in BYTES. */
  transcriptMaxBytes: int('TRANSCRIPT_MAX_BYTES', 262144),
});
