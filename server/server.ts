import express from 'express';
import path from 'node:path';
import { config } from './config';
import * as poller from './metricsPoller';
import * as sse from './sse';

const app = express();

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

poller.start();
const heartbeat = sse.startHeartbeat();

function shutdown(): void {
  clearInterval(heartbeat);
  poller.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
