import express from 'express';
import path from 'node:path';
import { config } from './config';
import { createStore, REQUEST_SERIES } from './db';
import * as poller from './metricsPoller';
import * as healthPoller from './healthPoller';
import * as sse from './sse';

const app = express();
const store = createStore({
  path: path.isAbsolute(config.dbPath)
    ? config.dbPath
    : path.join(__dirname, '..', config.dbPath),
  enabled: config.persistEnabled,
  retentionDays: config.retentionDays,
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/events', (req, res) => {
  sse.addClient(res);
  sse.sendSnapshot(res, poller.getSnapshot());
  req.on('close', () => sse.removeClient(res));
});

// Convenience/debug endpoint — plain JSON snapshot. Not required by either
// page's own code path since the SSE 'snapshot' event on connect already
// covers initial load.
app.get('/api/metrics', (_req, res) => {
  res.json(poller.getSnapshot());
});

/** Parses the shared from/to/buckets/names query shape. `buckets` is clamped
 *  because it sizes the GROUP BY output the client has to render. */
function parseRange(q: Record<string, unknown>, fallbackNames: string[]) {
  const int = (v: unknown, def: number): number => {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : def;
  };
  const to = int(q.to, Date.now());
  const from = int(q.from, to - 3600000);
  const buckets = Math.min(2000, Math.max(1, int(q.buckets, 240)));
  const raw = typeof q.names === 'string' ? q.names : '';
  const names = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : fallbackNames;
  return { from, to, buckets, names };
}

app.get('/api/history/series', (req, res) => {
  const { from, to, buckets, names } = parseRange(
    req.query as Record<string, unknown>,
    Object.keys(REQUEST_SERIES)
  );
  // `in` walks the prototype chain (so `?names=constructor` would slip past a
  // `n in REQUEST_SERIES` check and reach querySeries, whose Object.hasOwn
  // guard would then throw and escape this handler as a 500). Object.hasOwn
  // here keeps that rejection at the HTTP boundary as the intended 400.
  const unknown = names.filter(n => !Object.hasOwn(REQUEST_SERIES, n));
  if (unknown.length) {
    res.status(400).json({
      error: `unknown series: ${unknown.join(', ')}`,
      known: Object.keys(REQUEST_SERIES),
    });
    return;
  }
  res.json(store.querySeries(names, from, to, buckets));
});

app.get('/api/history/gauges', (req, res) => {
  const { from, to, buckets, names } = parseRange(req.query as Record<string, unknown>, []);
  res.json(store.queryGauges(names, from, to, buckets));
});

const server = app.listen(config.port, () => {
  console.log(`mtplx-dashboard listening on :${config.port}, polling ${config.mtplxUrl}`);
});

let shuttingDown = false;

/* healthPoller first and awaited: its first poll establishes the run that
   metricsPoller tags every request row with, so there is no nullable-run
   window at boot. The shuttingDown guard matters because this chain is not
   cancellable — a signal arriving during that first in-flight /health poll
   would otherwise start the metrics poller after shutdown() had already run. */
void healthPoller.start(store, () => sse.broadcastTick(poller.getSnapshot())).then(() => {
  if (!shuttingDown) poller.start(store);
});

const heartbeat = sse.startHeartbeat();
const pruneTimer = setInterval(() => store.prune(Date.now()), config.pruneIntervalMs);
store.prune(Date.now()); // one prune at boot, so a long downtime is cleaned up immediately

function shutdown(): void {
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(pruneTimer);
  poller.stop();
  healthPoller.stop();
  store.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
