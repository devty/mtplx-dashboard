import http from 'node:http';
import { config } from './config';
import { newRequestId, parseRequestBody, parseResponseBody, clientLabel, truncate } from './capture';
import type { EngineJoin } from './engineJoin';
import type { Store, RequestRow } from './db';
import type { Target } from './targets';

export interface ProxyDeps {
  target: Target;
  store: Pick<Store, 'insertRequestRow' | 'insertTranscript'>;
  join: EngineJoin;
  runId: () => number | null;
  /** False for a target with no scraper: claiming would stall the row until the
   *  wall-clock fallback fires. Such rows are written immediately with
   *  engineJoined false — honest, and no slower than the completion itself. */
  joinEnabled: boolean;
  onCaptured: (targetId: string, ts: number) => void;
  onUpstream: (targetId: string, ok: boolean) => void;
}

/* Hop-by-hop headers are meaningful to ONE connection; forwarding them onto a
   different socket is how a proxy corrupts connection reuse. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

const CAPTURE_PATH = '/v1/chat/completions';
const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

/** One listener per target, so both backends are proxied concurrently. */
const servers = new Map<string, http.Server>();

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on('data', c => {
      size += (c as Buffer).length;
      if (size > cap) { over = true; chunks.length = 0; return; }
      chunks.push(c as Buffer);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

async function capture(
  d: ProxyDeps,
  ctx: {
    startedAt: number; statusCode: number; streamed: boolean;
    parsedReq: ReturnType<typeof parseRequestBody>;
    responseBuf: Buffer | null; userAgent: string | undefined;
  }
): Promise<void> {
  try {
    const ts = Date.now();
    const parsedRes = ctx.responseBuf ? safe(() => parseResponseBody(ctx.responseBuf!)) : null;
    /* Streamed and failed requests are never engine-joined (spec section 7). */
    const engine = !d.joinEnabled || ctx.streamed || ctx.statusCode >= 400 ? null : await d.join.claim();

    const row: RequestRow = {
      requestId: newRequestId(),
      targetId: d.target.id,
      runId: d.runId(),
      ts,
      model: ctx.parsedReq?.model ?? null,
      promptTokens: parsedRes?.promptTokens ?? null,
      completionTokens: parsedRes?.completionTokens ?? null,
      ttftS: engine?.ttftS ?? null,
      requestElapsedS: (ts - ctx.startedAt) / 1000,
      decodeTokS: engine?.decodeTokS ?? null,
      clientLabel: clientLabel(ctx.userAgent),
      toolCallCount: parsedRes?.toolCallCount ?? null,
      userPreview: ctx.parsedReq?.userPreview ?? null,
      outcome: ctx.statusCode >= 200 && ctx.statusCode < 300 ? 'succeeded' : 'failed',
      statusCode: ctx.statusCode,
      streamed: ctx.streamed,
      finishReason: parsedRes?.finishReason ?? null,
      engineJoined: engine !== null,
    };

    d.store.insertRequestRow(row);

    if (!ctx.streamed && parsedRes) {
      const messages = safe(() => (ctx.parsedReq?.messages ? JSON.stringify(ctx.parsedReq.messages) : null));
      const tools = safe(() => (ctx.parsedReq?.tools ? JSON.stringify(ctx.parsedReq.tools) : null));
      const m = truncate(messages, config.transcriptMaxBytes);
      const r = truncate(parsedRes.responseText, config.transcriptMaxBytes);
      d.store.insertTranscript(row.requestId, m.value, r.value, tools, m.truncated || r.truncated);
    }
    d.onCaptured(d.target.id, ts);
  } catch {
    /* The completion is already delivered. Nothing here may surface. */
  }
}

function handle(d: ProxyDeps, req: http.IncomingMessage, res: http.ServerResponse): void {
  const base = new URL(d.target.upstreamUrl);
  const startedAt = Date.now();
  const captureThis = req.method === 'POST' && (req.url ?? '').startsWith(CAPTURE_PATH);

  void readBody(req, CAPTURE_MAX_BYTES).then(reqBody => {
    const parsedReq = captureThis && reqBody ? safe(() => parseRequestBody(reqBody)) : null;
    const streamed = parsedReq?.streamed === true;

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = base.host;

    const upstream = http.request(
      { protocol: base.protocol, hostname: base.hostname, port: base.port, method: req.method, path: req.url, headers },
      upRes => {
        d.onUpstream(d.target.id, true);
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);

        const chunks: Buffer[] = [];
        let size = 0;
        const collecting = captureThis && !streamed;

        upRes.on('data', chunk => {
          /* Tee: the client gets bytes on this same handler, so capture costs
             no latency. Never buffer-then-forward. */
          res.write(chunk);
          if (collecting) {
            size += (chunk as Buffer).length;
            if (size <= CAPTURE_MAX_BYTES) chunks.push(chunk as Buffer);
          }
        });
        upRes.on('end', () => {
          res.end();
          if (captureThis) {
            void capture(d, {
              startedAt, statusCode: upRes.statusCode ?? 0, streamed, parsedReq,
              responseBuf: collecting && size <= CAPTURE_MAX_BYTES ? Buffer.concat(chunks) : null,
              userAgent: req.headers['user-agent'],
            });
          }
        });
        upRes.on('error', () => { res.destroy(); });
      }
    );

    /* NO TIMEOUT, deliberately: gbrain does not time out local inference and a
       cold-cache MoE can run for minutes. config.scrapeTimeoutMs is 2500ms and
       belongs to the scrape path alone. */
    upstream.on('error', () => {
      d.onUpstream(d.target.id, false);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream unreachable', type: 'proxy_error' } }));
      if (captureThis) {
        void capture(d, { startedAt, statusCode: 502, streamed, parsedReq, responseBuf: null, userAgent: req.headers['user-agent'] });
      }
    });

    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });

    if (reqBody) upstream.end(reqBody);
    else req.pipe(upstream);
  });
}

export function start(d: ProxyDeps): void {
  if (!d.target.proxyPort) return;
  const srv = http.createServer((req, res) => handle(d, req, res));
  srv.listen(d.target.proxyPort, '127.0.0.1', () => {
    console.log(`capture proxy :${d.target.proxyPort} → ${d.target.upstreamUrl} (${d.target.id})`);
  });
  servers.set(d.target.id, srv);
}

export function stop(): void {
  for (const srv of servers.values()) srv.close();
  servers.clear();
}

export function listening(): number {
  return servers.size;
}
