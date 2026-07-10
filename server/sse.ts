import type { Response } from 'express';
import type { StatePayload } from './types';

const clients = new Set<Response>();

/** A client that stops draining (laptop asleep, dead wifi hop, backgrounded
 *  tab the OS never reports as closed) never fires `req.on('close')`, so it
 *  keeps receiving every broadcast — `res.write()` just queues the data in
 *  the socket's internal buffer forever. A single full StatePayload runs
 *  ~400KB (a 300-entry log buffer), so this caps a stalled client at ~10
 *  queued payloads' worth before we cut it loose, rather than letting it
 *  grow unbounded until the process OOMs. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function dropIfStalled(res: Response): boolean {
  if (res.writableLength <= MAX_BUFFERED_BYTES) return false;
  clients.delete(res);
  res.destroy();
  return true;
}

export function addClient(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering if ever fronted by nginx
  });
  res.write('\n'); // prime the stream
  clients.add(res);
}

export function removeClient(res: Response): void {
  clients.delete(res);
}

function writeEvent(res: Response, event: string, payload: unknown): void {
  if (dropIfStalled(res)) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function sendSnapshot(res: Response, payload: StatePayload): void {
  writeEvent(res, 'snapshot', payload);
}

export function broadcastTick(payload: StatePayload): void {
  for (const res of clients) writeEvent(res, 'tick', payload);
}

/** Heartbeat comment every `intervalMs` so idle SSE connections aren't reaped
 *  by proxies/load balancers; independent of data cadence. Also doubles as
 *  the stall check for clients that are idle enough not to hit writeEvent()
 *  between heartbeats. */
export function startHeartbeat(intervalMs = 20000): NodeJS.Timeout {
  return setInterval(() => {
    for (const res of clients) {
      if (dropIfStalled(res)) continue;
      res.write(': heartbeat\n\n');
    }
  }, intervalMs);
}
