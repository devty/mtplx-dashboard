import type { Response } from 'express';
import type { StatePayload } from './types';

const clients = new Set<Response>();

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
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function sendSnapshot(res: Response, payload: StatePayload): void {
  writeEvent(res, 'snapshot', payload);
}

export function broadcastTick(payload: StatePayload): void {
  for (const res of clients) writeEvent(res, 'tick', payload);
}

/** Heartbeat comment every `intervalMs` so idle SSE connections aren't reaped
 *  by proxies/load balancers; independent of data cadence. */
export function startHeartbeat(intervalMs = 20000): NodeJS.Timeout {
  return setInterval(() => {
    for (const res of clients) res.write(': heartbeat\n\n');
  }, intervalMs);
}
