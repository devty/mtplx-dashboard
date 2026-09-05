import express from 'express';
import path from 'node:path';
import { config } from './config';
import { createStore, REQUEST_SERIES } from './db';
import { createDreamService } from './dreamService';
import * as scraper from './promScraper';
import * as healthPoller from './healthPoller';
import * as sse from './sse';

const app = express();

const target = config.targets[0]; // Phase 1 is single-target

const store = createStore({
  path: path.isAbsolute(config.dbPath)
    ? config.dbPath
    : path.join(__dirname, '..', config.dbPath),
  enabled: config.persistEnabled,
  retentionDays: config.retentionDays,
  transcriptRetentionDays: config.transcriptRetentionDays,
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/events', (req, res) => {
  sse.addClient(res);
  sse.sendSnapshot(res, scraper.getSnapshot());
  req.on('close', () => sse.removeClient(res));
});

// Convenience/debug endpoint — plain JSON snapshot. Not required by either
// page's own code path since the SSE 'snapshot' event on connect already
// covers initial load.
app.get('/api/metrics', (_req, res) => {
  res.json(scraper.getSnapshot());
});

/** Parses the shared from/to/buckets/names query shape. `buckets` is clamped
 *  because it sizes the GROUP BY output the client has to render.
 *
 *  `names` accepts two shapes: a single comma-joined string (the
 *  REQUEST_SERIES convention — `decode`/`ttft` never contain a comma) or
 *  repeated `?names=a&names=b` params, which Express/qs collect into an
 *  array. Gauge series names can carry more than one label and are NOT safe
 *  to comma-join: promSeries.ts's seriesName() keeps every label but `model`
 *  and `family`, so a series like
 *  `suffix_decode_fallthrough_total{method=suffix,reason=batch_size}` has a
 *  literal comma inside it. Percent-encoding that comma does not survive a
 *  single joined query value either — Express decodes the whole value before
 *  this function ever splits it, so an escaped internal comma and the
 *  delimiter comma become indistinguishable. Repeated params sidestep this
 *  entirely: each occurrence is decoded independently. */
function parseRange(q: Record<string, unknown>, fallbackNames: string[]) {
  const int = (v: unknown, def: number): number => {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : def;
  };
  const to = int(q.to, Date.now());
  const from = int(q.from, to - 3600000);
  const buckets = Math.min(2000, Math.max(1, int(q.buckets, 240)));

  let names: string[];
  if (Array.isArray(q.names)) {
    names = q.names.map(v => String(v).trim()).filter(Boolean);
  } else if (typeof q.names === 'string' && q.names) {
    names = q.names.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    names = fallbackNames;
  }
  return { from, to, buckets, names };
}

/** Target for a history query. Falls back to the single configured target, so
 *  existing URLs without ?target= keep working. */
function queryTarget(q: Record<string, unknown>): string {
  return typeof q.target === 'string' && q.target ? q.target : target.id;
}

app.get('/api/history/series', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to, buckets, names } = parseRange(q, Object.keys(REQUEST_SERIES));
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
  res.json(store.querySeries(queryTarget(q), names, from, to, buckets));
});

app.get('/api/history/gauges', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to, buckets, names } = parseRange(q, []);
  res.json(store.queryGauges(queryTarget(q), names, from, to, buckets));
});

/** Series present in the gauge table for a target. The set is discovered, not
 *  hardcoded — it differs by backend and grows after first traffic (59/73/80
 *  across the committed fixtures). Safe to expose dynamically because gauge
 *  names are bound as parameters, unlike REQUEST_SERIES. */
app.get('/api/history/gauge-names', (req, res) => {
  const t = typeof req.query.target === 'string' ? req.query.target : target.id;
  res.json({ target: t, names: store.gaugeNames(t) });
});

app.get('/api/history/runs', (req, res) => {
  const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 20;
  res.json({ runs: store.queryRuns(limit) });
});

app.get('/api/history/runs/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid run id' });
    return;
  }
  const run = store.getRun(id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  res.json(run);
});

const dream = createDreamService(store);

app.get('/api/dream/nights', (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 365) : 14;
  res.json(dream.nights(limit));
});

app.get('/api/dream/nights/:date', (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const detail = dream.night(req.params.date);
  if (!detail) {
    res.status(404).json({ error: 'no such night' });
    return;
  }
  res.json(detail);
});

const server = app.listen(config.port, () => {
  console.log(`mtplx-dashboard listening on :${config.port}, scraping ${target.label} (${target.upstreamUrl})`);
});

/* healthPoller's first poll is awaited before the scraper starts, so the
   scraper's first observe() call is guaranteed to see engine_type/
   context_window already populated (see runTracker) rather than racing three
   small JSON fetches against one ~28 KB text fetch — a race the scraper could
   win, permanently baking NULLs into that run's row (upsertRun never updates
   an existing row). Awaiting reintroduces a genuine async gap at startup, so
   `shuttingDown` guards it: without the check, a SIGTERM arriving during that
   first health fetch would let shutdown() run to completion and then have
   this .then() callback start the scraper anyway, after the server believes
   it has already shut down. */
let shuttingDown = false;
void healthPoller.start(target).then(() => {
  if (!shuttingDown) scraper.start(target, store);
});

const heartbeat = sse.startHeartbeat();
const pruneTimer = setInterval(() => store.prune(Date.now()), config.pruneIntervalMs);
store.prune(Date.now()); // one prune at boot, so a long downtime is cleaned up immediately

function shutdown(): void {
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(pruneTimer);
  scraper.stop();
  healthPoller.stop();
  store.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
