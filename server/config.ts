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

export const config = Object.freeze({
  mtplxUrl: str('MTPLX_URL', 'http://127.0.0.1:8000').replace(/\/+$/, ''),
  port: int('PORT', 8123),
  pollIntervalMs: int('POLL_INTERVAL_MS', 1000),
  mtplxTimeoutMs: int('MTPLX_TIMEOUT_MS', 2500),
  ringSize: int('RING_SIZE', 120),
  logBufferSize: int('LOG_BUFFER_SIZE', 300),
  maxBackoffMs: int('MAX_BACKOFF_MS', 10000),
});
