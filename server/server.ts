import express from 'express';
import path from 'node:path';
import { config } from './config';
import { createStore } from './db';
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

const server = app.listen(config.port, () => {
  console.log(`mtplx-dashboard listening on :${config.port}, polling ${config.mtplxUrl}`);
});

/* healthPoller first and awaited: its first poll establishes the run that
   metricsPoller tags every request row with, so there is no nullable-run
   window at boot. */
void healthPoller.start(store).then(() => poller.start(store));

const heartbeat = sse.startHeartbeat();
const pruneTimer = setInterval(() => store.prune(Date.now()), config.pruneIntervalMs);
store.prune(Date.now()); // one prune at boot, so a long downtime is cleaned up immediately

function shutdown(): void {
  clearInterval(heartbeat);
  clearInterval(pruneTimer);
  poller.stop();
  healthPoller.stop();
  store.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
