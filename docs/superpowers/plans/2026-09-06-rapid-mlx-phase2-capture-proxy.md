# rapid-mlx Phase 2: Capture Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an OpenAI-compatible capture proxy in front of the qwen rapid-mlx backend so the dashboard regains per-request identity — ids, prompts, responses, tool calls, timings — and restore the live-log and detail pages that Phase 1 had to turn into explanatory panels.

**Architecture:** A raw `node:http` reverse proxy listens on its own port inside the existing dashboard process and forwards `/v1/*` to the upstream verbatim. Non-streaming `/v1/chat/completions` responses are *teed* — piped to the client and accumulated simultaneously — so capture costs zero added latency. Engine-measured TTFT and decode rate arrive from the Prometheus scrape a beat later and are joined onto the request only when unambiguous. Everything the proxy records goes to SQLite; the log and detail pages read from there rather than from an in-memory buffer, so history survives a restart.

**Tech Stack:** TypeScript 5.5 (CommonJS, `strict`), Node >= 22.5, `node:http` for the proxy (deliberately not Express — no middleware between us and the wire), Express 4 for the existing dashboard, `node:sqlite`, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-rapid-mlx-prometheus-design.md` — read it before starting. This plan implements the spec's **Phase 2** (spec §10). Phase 3 (second target, selector UI, history's second axis) gets its own plan.

**Builds on:** the completed Phase 1 branch. `db.ts` already has the `request` and `transcript` tables, `insertRequestRow`, `insertTranscript` and the `engine_joined` column; `targets.ts` already parses `proxyPort`; `types.ts` already reserves `upstreamOk`. None of that needs a schema change.

## Global Constraints

- **No new runtime dependencies.** Express and `node:*` only. Do not add `http-proxy`, `node-fetch`, or a proxy library — the forwarding is ~40 lines and a library would obscure the header and streaming semantics this task exists to control.
- **Node >= 22.5**, CommonJS output, `strict: true`. `node:sqlite` is the only database binding.
- **NO TIMEOUT ON THE FORWARD PATH.** gbrain deliberately does not time out local inference (`test/ai/local-fetch-no-timeout.test.ts`); a cold-cache 35B MoE can legitimately run for minutes. `config.scrapeTimeoutMs` is for scraping and must never be applied to forwarding. Do not add a forward timeout with a default, and do not reuse the scrape budget.
- **Forward first, capture second.** Every capture, parse and persist call is wrapped so a failure degrades to a missing log entry, never to a failed completion.
- **Upstream errors pass through verbatim** — status, headers, body. Never synthesize a response, never retry: a retried non-idempotent completion double-bills compute and corrupts the engine's own counters.
- **Streaming pipes straight through.** Buffering a stream would delay first token, the exact metric this dashboard exists to protect.
- **Persistence must never break the live dashboard.** Every `Store` method catches its own errors and degrades via `fail()`.
- `REQUEST_SERIES` stays a closed `Object.hasOwn` allowlist (interpolated into SQL); gauge names stay parameter-bound. Do not unify.
- Rendering/formatting stays duplicated across `public/*.html`. Do not factor into a shared module.
- Test files are `server/*.test.ts`, excluded from the tsconfig build.
- Commit after every task. Conventional-commit prefixes.

---

## Design decisions this plan makes

Recorded here because they are not all spelled out in the spec, and an implementer reading one task should not have to re-derive them.

**D1 — The proxy is a raw `node:http` server, not an Express app.** Express normalises headers, may consume the body, and inserts middleware between us and the wire. A proxy's job is to be transparent; `http.createServer` + `http.request` is the transparent path and is barely longer.

**D2 — Capture is a tee, not a buffer-then-forward.** The upstream response is piped to the client *and* accumulated in the same `data` handler. The client sees bytes at the same instant it would without the proxy. Buffer-then-forward would be simpler to write and would add latency proportional to response size — unacceptable in the one path this project measures.

**D3 — Streamed requests still get a `request` row, with no transcript.** Spec §7 says streaming is "uncaptured", meaning no body capture and no TTFT join, and that stands. But the row itself — id, timestamp, model, wall-clock elapsed, `streamed = 1`, outcome, status — costs nothing and is honest. Recording nothing would make a streaming client invisible in the log, which reads as "no traffic" rather than "traffic we do not introspect". This is a deliberate, minimal extension of the spec, not an oversight.

**D4 — The engine join is asynchronous and one-shot.** The proxy knows a request finished at time T; the engine's counters only reflect it at the next scrape, up to `pollIntervalMs` later. So the proxy registers a waiter and the scraper resolves it: when the next tick shows `completedDelta === 1`, the single waiting request gets that tick's engine-measured TTFT and decode rate. When `completedDelta > 1`, every waiter it covers resolves to `null` and `engine_joined` is stored `0` — the delta is a mean across several requests and attributing it to one would fabricate a per-request number.

**D5 — log/detail read from SQLite, not from an in-memory ring.** The MTPLX-era pages read a server-side log buffer that died with the process. Reading the `request` table instead means the log survives restarts, needs no `StatePayload` growth, and gives `detail.html` a real permalink. `StatePayload` gains only `lastRequestAt` so the client knows when to refetch.

**D6 — The dashboard gets a launchd plist with `KeepAlive`.** Phase 2 puts this process in gbrain's inference path, including the unattended 07:05 nightly dream. Supervision converts a crash from "inference is down until someone notices" into a seconds-long blip, and matches how both rapid-mlx servers already run.

---

## File Structure

**Created:**
- `server/capture.ts` — pure extraction from request/response JSON: id minting, prompt preview, tool-call count, usage, finish reason, client label, body truncation. No I/O, no clock beyond what is passed in.
- `server/capture.test.ts`
- `server/engineJoin.ts` — the one-shot waiter queue implementing D4. Pure logic over an injected clock.
- `server/engineJoin.test.ts`
- `server/proxy.ts` — the reverse proxy. The only module here that touches sockets.
- `server/proxy.test.ts` — integration tests against a stub upstream on an ephemeral port.
- `scripts/com.local.mtplx-dashboard.plist` — launchd unit (D6).
- `scripts/install-launchd.sh` — installs/loads it, and prints the gbrain repoint steps.

**Modified:**
- `server/db.ts` — `queryRequests()`, `getRequest()` for the log and detail pages.
- `server/db.test.ts`
- `server/promScraper.ts` — resolve engine-join waiters; own `upstreamOk`.
- `server/promScraper.test.ts`
- `server/types.ts` — `upstreamOk` becomes real; add `lastRequestAt`.
- `server/config.ts` — `CAPTURE_ENABLED`, `TRANSCRIPT_MAX_BYTES`.
- `server/server.ts` — start/stop the proxy, `/api/requests` endpoints.
- `public/log.html`, `public/detail.html` — restored from SQLite.
- `public/index.html` — banner distinguishes `scrapeOk` from `upstreamOk`.
- `CLAUDE.md`, `README.md`, `.env.example`.

---

## Task 1: Capture extraction (pure)

**Files:**
- Create: `server/capture.ts`
- Test: `server/capture.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `function newRequestId(): string`
  - `interface CapturedRequest { model: string | null; messages: unknown[] | null; tools: unknown[] | null; streamed: boolean; userPreview: string | null }`
  - `interface CapturedResponse { promptTokens: number | null; completionTokens: number | null; toolCallCount: number | null; finishReason: string | null; responseText: string | null }`
  - `function parseRequestBody(buf: Buffer): CapturedRequest | null`
  - `function parseResponseBody(buf: Buffer): CapturedResponse | null`
  - `function clientLabel(userAgent: string | undefined): string | null`
  - `function truncate(s: string | null, maxBytes: number): { value: string | null; truncated: boolean }`

**Background you need:** These functions run on every proxied request, so they must never throw — a malformed body is a capture miss, not a failed completion. Every one returns `null` rather than throwing on anything it does not understand.

The request body is an OpenAI chat-completions payload: `{ model, messages: [{role, content}], tools?, stream? }`. The response is `{ model, choices: [{ message: { content, tool_calls? }, finish_reason }], usage: { prompt_tokens, completion_tokens } }`. `content` may be a string or an array of content parts (rapid-mlx's vision lane); handle both.

`truncate` counts **bytes, not characters** — a 256 KB cap that counts UTF-16 code units would let a CJK transcript through at ~3× the intended size. It must also not split a multi-byte character in half.

- [ ] **Step 1: Write the failing test**

Create `server/capture.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newRequestId, parseRequestBody, parseResponseBody, clientLabel, truncate,
} from './capture';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

test('newRequestId is unique and url-safe', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8,}$/);
});

test('parses a plain chat-completions request', () => {
  const r = parseRequestBody(buf({
    model: 'qwen', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi there' }],
  }));
  assert.equal(r?.model, 'qwen');
  assert.equal(r?.streamed, false);
  assert.equal(r?.userPreview, 'hi there');
  assert.equal(r?.messages?.length, 2);
  assert.equal(r?.tools, null);
});

/* The preview must be the LAST user turn, not the first — an agentic
   conversation replays its whole history on every call, so the first user
   message is the same string for hundreds of rows. */
test('userPreview takes the last user message, not the first', () => {
  const r = parseRequestBody(buf({
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'second question' },
    ],
  }));
  assert.equal(r?.userPreview, 'second question');
});

test('userPreview flattens array-shaped content parts', () => {
  const r = parseRequestBody(buf({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }],
  }));
  assert.equal(r?.userPreview, 'part one part two');
});

test('detects streaming and tools', () => {
  const r = parseRequestBody(buf({
    stream: true, tools: [{ type: 'function', function: { name: 'search' } }],
    messages: [{ role: 'user', content: 'x' }],
  }));
  assert.equal(r?.streamed, true);
  assert.equal(r?.tools?.length, 1);
});

test('a body with no user message yields a null preview, not a throw', () => {
  const r = parseRequestBody(buf({ messages: [{ role: 'system', content: 'only system' }] }));
  assert.equal(r?.userPreview, null);
});

test('malformed or non-JSON request bodies yield null', () => {
  assert.equal(parseRequestBody(Buffer.from('not json at all')), null);
  assert.equal(parseRequestBody(Buffer.from('')), null);
  assert.equal(parseRequestBody(buf('a bare string')), null);
  assert.equal(parseRequestBody(buf(42)), null);
});

test('parses a completed response', () => {
  const r = parseResponseBody(buf({
    choices: [{ message: { role: 'assistant', content: 'Hi! How can I help?' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 15, completion_tokens: 9 },
  }));
  assert.equal(r?.promptTokens, 15);
  assert.equal(r?.completionTokens, 9);
  assert.equal(r?.finishReason, 'stop');
  assert.equal(r?.responseText, 'Hi! How can I help?');
  assert.equal(r?.toolCallCount, 0);
});

test('counts tool calls on the response', () => {
  const r = parseResponseBody(buf({
    choices: [{ message: { tool_calls: [{ id: 'a' }, { id: 'b' }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  }));
  assert.equal(r?.toolCallCount, 2);
  assert.equal(r?.finishReason, 'tool_calls');
});

test('an error-shaped response yields nulls rather than throwing', () => {
  const r = parseResponseBody(buf({ error: { message: 'context length exceeded' } }));
  assert.equal(r?.promptTokens, null);
  assert.equal(r?.completionTokens, null);
  assert.equal(r?.responseText, null);
  assert.equal(r?.finishReason, null);
});

test('malformed response bodies yield null', () => {
  assert.equal(parseResponseBody(Buffer.from('<html>502</html>')), null);
  assert.equal(parseResponseBody(Buffer.from('')), null);
});

test('clientLabel extracts a product token', () => {
  assert.equal(clientLabel('node'), 'node');
  assert.equal(clientLabel('OpenAI/JS 4.20.1'), 'OpenAI/JS');
  assert.equal(clientLabel(undefined), null);
  assert.equal(clientLabel(''), null);
});

/* The cap is a BYTE budget. Counting UTF-16 units would let a CJK transcript
   through at roughly three times the intended size. */
test('truncate counts bytes, not characters', () => {
  const ascii = 'a'.repeat(100);
  assert.deepEqual(truncate(ascii, 100), { value: ascii, truncated: false });
  assert.equal(truncate(ascii, 10).value, 'a'.repeat(10));
  assert.equal(truncate(ascii, 10).truncated, true);
});

test('truncate never splits a multi-byte character', () => {
  const t = truncate('経経経', 4);                      // 4 bytes cuts mid-character
  assert.equal(t.value, '経');                          // not a replacement char
  assert.equal(t.truncated, true);
});

/* Exact-boundary cases, asserted by VALUE. An upper-bound assertion
   (byteLength <= cap) cannot distinguish a correct result from one that
   silently discards a character which fit — which is exactly the bug an
   earlier version of this function had. */
test('truncate keeps a character that completes exactly at the cap', () => {
  assert.equal(truncate('経'.repeat(100), 3).value, '経');
  assert.equal(truncate('経'.repeat(100), 30).value, '経'.repeat(10));
  assert.equal(Buffer.byteLength(truncate('経'.repeat(100), 30).value!, 'utf8'), 30);
});

/* 4-byte sequences take a different walk-back path from 3-byte ones. */
test('truncate handles 4-byte sequences at and across the boundary', () => {
  assert.equal(truncate('a😀b', 5).value, 'a😀');       // 1 + 4 fits exactly
  assert.equal(truncate('a😀b', 4).value, 'a');         // the emoji genuinely does not fit
  assert.equal(truncate('😀😀', 4).value, '😀');
  assert.equal(truncate('😀😀', 3).value, '');          // nothing whole fits
});

test('truncate handles a zero or negative cap', () => {
  assert.deepEqual(truncate('anything', 0), { value: '', truncated: true });
  assert.deepEqual(truncate('', 0), { value: '', truncated: false });
});

test('truncate passes null through', () => {
  assert.deepEqual(truncate(null, 100), { value: null, truncated: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/capture.test.ts`
Expected: FAIL — `Cannot find module './capture'`.

- [ ] **Step 3: Write the implementation**

Create `server/capture.ts`:

```ts
import crypto from 'node:crypto';

/** Every function here runs on the proxy's hot path for a request that is
 *  already being served. None of them may throw: a body we cannot parse is a
 *  capture miss, never a failed completion. They return null instead. */

export interface CapturedRequest {
  model: string | null;
  messages: unknown[] | null;
  tools: unknown[] | null;
  streamed: boolean;
  userPreview: string | null;
}

export interface CapturedResponse {
  promptTokens: number | null;
  completionTokens: number | null;
  toolCallCount: number | null;
  finishReason: string | null;
  responseText: string | null;
}

const PREVIEW_CHARS = 180;

export function newRequestId(): string {
  return crypto.randomBytes(9).toString('base64url');
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function json(buf: Buffer): Record<string, unknown> | null {
  if (!buf.length) return null;
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `content` is a string on a plain turn and an array of parts on the vision
 *  lane. Both shapes appear against this server. */
function flattenContent(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map(p => (p && typeof p === 'object' ? str((p as { text?: unknown }).text) : null))
    .filter((s): s is string => s !== null);
  return parts.length ? parts.join(' ') : null;
}

export function parseRequestBody(buf: Buffer): CapturedRequest | null {
  const b = json(buf);
  if (!b) return null;

  const messages = Array.isArray(b.messages) ? (b.messages as unknown[]) : null;
  const tools = Array.isArray(b.tools) && b.tools.length ? (b.tools as unknown[]) : null;

  /* LAST user turn, not first. An agentic conversation replays its whole
     history every call, so the first user message is identical across
     hundreds of rows and useless as a preview. */
  let userPreview: string | null = null;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i] as { role?: unknown; content?: unknown } | null;
    if (m && typeof m === 'object' && m.role === 'user') {
      const text = flattenContent(m.content);
      if (text) userPreview = text.slice(0, PREVIEW_CHARS);
      break;
    }
  }

  return { model: str(b.model), messages, tools, streamed: b.stream === true, userPreview };
}

export function parseResponseBody(buf: Buffer): CapturedResponse | null {
  const b = json(buf);
  if (!b) return null;

  const choices = Array.isArray(b.choices) ? b.choices : [];
  const first = (choices[0] ?? null) as
    | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
    | null;
  const usage = (b.usage ?? null) as { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
  const toolCalls = first?.message?.tool_calls;

  return {
    promptTokens: num(usage?.prompt_tokens),
    completionTokens: num(usage?.completion_tokens),
    toolCallCount: choices.length ? (Array.isArray(toolCalls) ? toolCalls.length : 0) : null,
    finishReason: str(first?.finish_reason),
    responseText: first ? flattenContent(first.message?.content) : null,
  };
}

/** The product token of a User-Agent — enough to tell gbrain from a curl
 *  probe without storing a fingerprint. */
export function clientLabel(userAgent: string | undefined): string | null {
  const ua = str(userAgent);
  if (!ua) return null;
  return ua.split(/[\s(]/)[0] || null;
}

/** Truncates to a BYTE budget without splitting a multi-byte character.
 *  A character budget would let a CJK transcript through at ~3x the cap. */
export function truncate(s: string | null, maxBytes: number): { value: string | null; truncated: boolean } {
  if (s === null) return { value: null, truncated: false };
  if (maxBytes <= 0) return { value: '', truncated: s.length > 0 };
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { value: s, truncated: false };

  const cut = Buffer.from(s, 'utf8').subarray(0, maxBytes);

  /* Walk back over continuation bytes (0b10xxxxxx) to the lead byte of the
     last sequence, then keep that sequence only if it COMPLETED inside the
     cut. Dropping the lead byte unconditionally is the tempting one-liner and
     it is wrong: when the cap lands exactly on a character boundary the
     sequence is whole, and discarding it throws away a character that fit.
     For 3-byte text and a cap that is a multiple of 3 that is every character,
     and a cap of 3 yields "". */
  let lead = cut.length - 1;
  while (lead >= 0 && (cut[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return { value: '', truncated: true };

  const b = cut[lead];
  const seqLen = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  const end = lead + seqLen <= cut.length ? cut.length : lead;
  return { value: cut.subarray(0, end).toString('utf8'), truncated: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/capture.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/capture.ts server/capture.test.ts
git commit -m "feat: pure request/response capture extraction"
```

---

## Task 2: The engine join

**Files:**
- Create: `server/engineJoin.ts`
- Test: `server/engineJoin.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module — the scraper drives it, but it imports nothing).
- Produces:
  - `interface EngineSample { ttftS: number | null; decodeTokS: number | null }`
  - `class EngineJoin` with:
    - `constructor(opts?: { maxTicks?: number; maxWaiters?: number; claimTimeoutMs?: number })`
    - `claim(): Promise<EngineSample | null>`
    - `settle(completedDelta: number | null, sample: EngineSample): void`
    - `abandon(): void`
    - `pending(): number`

**Background you need — this is the subtlest module in Phase 2.** Spec §4.2: a non-streaming proxy cannot measure TTFT. It sees only the finished response, so it knows wall-clock elapsed but not time-to-*first*-token, and not decode rate separated from prefill. Those come from the Prometheus scrape.

But the scrape is up to `pollIntervalMs` behind. So the proxy finishes a request, registers a claim, and the *scraper* resolves it on its next tick:

- `settle(1, s)` — exactly one request completed in that interval. The single oldest waiter gets `s`: this is a genuine per-request measurement.
- `settle(n, s)` where `n > 1` — the interval covered several requests, so `Δsum/Δcount` is a **mean** across them. The oldest `n` waiters resolve to `null`. Attributing a mean to one request would fabricate a number, which is exactly what the spec forbids.
- `settle(0 | null, s)` — nothing completed (or the counter was absent/reset). Nobody resolves.

Two failure modes the design must survive:

1. **A tick lands between completion and registration.** The delta is consumed with no waiter present, and our claim would then wait forever. Each waiter therefore counts ticks and resolves `null` after `maxTicks` (default 3) settles without being covered.
2. **A completion the proxy never saw** — someone curls the upstream directly, bypassing the proxy. Then `completedDelta` exceeds the waiter count. Resolve every waiter it covers to `null` and discard the remainder; guessing which of our requests the engine meant would be worse than admitting we do not know.

Claims must never reject and never leak: `maxWaiters` (default 64) bounds the queue, and the oldest is resolved `null` when it overflows.

**And a third failure mode, which the tick bound alone does not cover** (controller ruling R1): `settle()` runs only on a *successful* scrape — deliberately, so a `/metrics` outage does not age waiters out for something that is not their fault. But that means during an outage nothing settles at all, so `ticks` never advances, no waiter ever resolves, and the proxy's `persist()` never runs. Requests would keep being served perfectly and silently vanish from the log — exactly when the log matters most. Each waiter therefore also arms a **wall-clock** fallback, `claimTimeoutMs` (default 15000 ms, comfortably above `pollIntervalMs × maxTicks`), which resolves `null`. The timer is cleared on normal resolution and `unref()`'d so a pending claim can never hold the process open at shutdown.

- [ ] **Step 1: Write the failing test**

Create `server/engineJoin.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineJoin } from './engineJoin';
import type { EngineSample } from './engineJoin';

const S = (ttftS: number, decodeTokS: number): EngineSample => ({ ttftS, decodeTokS });

test('exactly one completion resolves the single waiter with the sample', async () => {
  const j = new EngineJoin();
  const p = j.claim();
  j.settle(1, S(0.39, 36.7));
  assert.deepEqual(await p, { ttftS: 0.39, decodeTokS: 36.7 });
  assert.equal(j.pending(), 0);
});

/* Δsum/Δcount over an interval covering several requests is a MEAN. Handing
   it to one request would fabricate a per-request measurement. */
test('several completions in one interval resolve every covered waiter to null', async () => {
  const j = new EngineJoin();
  const a = j.claim(), b = j.claim(), c = j.claim();
  j.settle(3, S(0.5, 30));
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(await c, null);
});

test('a partial interval resolves only the oldest waiters, in order', async () => {
  const j = new EngineJoin();
  const first = j.claim(), second = j.claim();
  j.settle(1, S(0.2, 40));
  assert.deepEqual(await first, { ttftS: 0.2, decodeTokS: 40 });
  assert.equal(j.pending(), 1);
  j.settle(1, S(0.9, 12));
  assert.deepEqual(await second, { ttftS: 0.9, decodeTokS: 12 });
});

test('a quiet tick resolves nobody', async () => {
  const j = new EngineJoin();
  const p = j.claim();
  j.settle(0, S(1, 1));
  j.settle(null, S(1, 1));
  assert.equal(j.pending(), 1);
  j.settle(1, S(0.3, 22));
  assert.deepEqual(await p, { ttftS: 0.3, decodeTokS: 22 });
});

/* A tick can land between the response ending and the claim registering; the
   delta is then consumed with nobody waiting. Without a bound the claim would
   never settle and the request row would never be written. */
test('a waiter never covered resolves null after maxTicks', async () => {
  const j = new EngineJoin({ maxTicks: 3 });
  const p = j.claim();
  j.settle(0, S(1, 1));
  j.settle(0, S(1, 1));
  assert.equal(j.pending(), 1);
  j.settle(0, S(1, 1));
  assert.equal(await p, null);
  assert.equal(j.pending(), 0);
});

/* Someone curling the upstream directly produces completions the proxy never
   saw, so the delta can exceed the queue. */
test('more completions than waiters resolves all of them to null', async () => {
  const j = new EngineJoin();
  const a = j.claim(), b = j.claim();
  j.settle(5, S(0.4, 30));
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(j.pending(), 0);
});

test('overflow resolves the oldest waiter rather than growing without bound', async () => {
  const j = new EngineJoin({ maxWaiters: 2 });
  const a = j.claim();
  j.claim();
  j.claim();                      // pushes a out
  assert.equal(await a, null);
  assert.equal(j.pending(), 2);
});

test('abandon resolves everything to null', async () => {
  const j = new EngineJoin();
  const a = j.claim(), b = j.claim();
  j.abandon();
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(j.pending(), 0);
});

/* settle() runs only on a SUCCESSFUL scrape, so during a /metrics outage
   nothing settles and the tick bound never advances. Without a wall-clock
   fallback the proxy's persist() would never run and the request would vanish
   from the log — exactly when the log matters most. */
test('a claim resolves null on its own when the scraper never settles', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 30 });
  const p = j.claim();
  assert.equal(await p, null);
  assert.equal(j.pending(), 0);
});

test('the wall-clock timer is cleared when a claim settles normally', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 30 });
  const p = j.claim();
  j.settle(1, S(0.2, 40));
  assert.deepEqual(await p, { ttftS: 0.2, decodeTokS: 40 });
  /* Nothing pending, and no stray timer may fire later against a resolved
     promise or hold the event loop open. */
  await new Promise(r => setTimeout(r, 50));
  assert.equal(j.pending(), 0);
});

test('claims never reject', async () => {
  const j = new EngineJoin();
  const p = j.claim();
  j.settle(1, { ttftS: null, decodeTokS: null });
  assert.deepEqual(await p, { ttftS: null, decodeTokS: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/engineJoin.test.ts`
Expected: FAIL — `Cannot find module './engineJoin'`.

- [ ] **Step 3: Write the implementation**

Create `server/engineJoin.ts`:

```ts
/** Engine-measured values for one completed request, as read from the scrape
 *  rather than observed at the wire. */
export interface EngineSample {
  ttftS: number | null;
  decodeTokS: number | null;
}

interface Waiter {
  resolve: (s: EngineSample | null) => void;
  ticks: number;
  /** Wall-clock escape hatch — see the claimTimeoutMs note below. */
  timer: NodeJS.Timeout;
}

/** Joins a proxied request to the engine's own measurement of it.
 *
 *  A non-streaming proxy sees only the finished response: it knows wall-clock
 *  elapsed but not time-to-first-token, and not decode rate separated from
 *  prefill. Those live in the Prometheus histogram, which is up to one poll
 *  interval behind. So the proxy claims, and the scraper settles.
 *
 *  The whole point of this class is the ambiguity rule (spec section 4.2):
 *  Δsum/Δcount is a per-request measurement ONLY when Δcount is exactly 1.
 *  Over any wider interval it is a mean, and this returns null rather than
 *  handing a mean to one request as if it were that request's own. */
export class EngineJoin {
  private waiters: Waiter[] = [];
  private readonly maxTicks: number;
  private readonly maxWaiters: number;
  private readonly claimTimeoutMs: number;

  constructor(opts: { maxTicks?: number; maxWaiters?: number; claimTimeoutMs?: number } = {}) {
    this.maxTicks = opts.maxTicks ?? 3;
    this.maxWaiters = opts.maxWaiters ?? 64;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 15_000;
  }

  /** Single exit for every waiter, so the wall-clock timer is always cleared. */
  private finish(w: Waiter, s: EngineSample | null): void {
    clearTimeout(w.timer);
    w.resolve(s);
  }

  /** Never rejects. Resolves with the engine's sample, or null when no
   *  unambiguous one is available. */
  claim(): Promise<EngineSample | null> {
    return new Promise(resolve => {
      /* Bound the queue: a scraper that stops settling (upstream down, dashboard
         mid-restart) must not accumulate waiters for every request served. */
      if (this.waiters.length >= this.maxWaiters) {
        const oldest = this.waiters.shift();
        if (oldest) this.finish(oldest, null);
      }

      const w: Waiter = { resolve, ticks: 0, timer: undefined as unknown as NodeJS.Timeout };
      /* The tick bound only advances when the scraper settles, and it settles
         only on a SUCCESSFUL scrape. During a /metrics outage nothing settles
         at all, so without this the request row would never be written. */
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          this.finish(w, null);
        }
      }, this.claimTimeoutMs);
      w.timer.unref?.();
      this.waiters.push(w);
    });
  }

  /** Called by the scraper once per successful tick. */
  settle(completedDelta: number | null, sample: EngineSample): void {
    const n = completedDelta ?? 0;

    if (n === 1 && this.waiters.length > 0) {
      this.finish(this.waiters.shift()!, sample);
    } else if (n > 1) {
      /* A mean across several requests — nobody gets it. If the delta exceeds
         the queue (a client bypassing the proxy) the surplus is simply
         discarded; there is no waiter it could belong to. */
      for (let i = 0; i < n && this.waiters.length > 0; i++) {
        this.finish(this.waiters.shift()!, null);
      }
    }

    /* Age whoever is left. A tick landing between response-end and claim
       consumes the delta with nobody waiting, so an uncovered waiter must
       eventually give up or its request row is never written. */
    const survivors: Waiter[] = [];
    for (const w of this.waiters) {
      if (++w.ticks >= this.maxTicks) this.finish(w, null);
      else survivors.push(w);
    }
    this.waiters = survivors;
  }

  /** Restart or shutdown: nothing pending can still be answered truthfully. */
  abandon(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) this.finish(w, null);
  }

  pending(): number {
    return this.waiters.length;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/engineJoin.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/engineJoin.ts server/engineJoin.test.ts
git commit -m "feat: engine-join queue with the Δcount==1 ambiguity rule"
```

---

## Task 3: Request queries for the log and detail pages

**Files:**
- Modify: `server/db.ts`
- Test: `server/db.test.ts`

**Interfaces:**
- Consumes: the existing `request` and `transcript` tables (created in Phase 1, still empty).
- Produces:
  - `interface RequestSummary { requestId: string; ts: number; model: string | null; promptTokens: number | null; completionTokens: number | null; ttftS: number | null; requestElapsedS: number | null; decodeTokS: number | null; clientLabel: string | null; toolCallCount: number | null; userPreview: string | null; outcome: string | null; statusCode: number | null; streamed: boolean; finishReason: string | null; engineJoined: boolean }`
  - `interface RequestDetail extends RequestSummary { runId: number | null; messages: string | null; responseText: string | null; tools: string | null; truncated: boolean; transcriptPresent: boolean }`
  - `Store.queryRequests(targetId: string, limit: number, before: number | null): RequestSummary[]`
  - `Store.getRequest(requestId: string): RequestDetail | null`

**Background you need:** These back the restored log and detail pages (design decision D5 — they read SQLite rather than an in-memory ring, so the log survives a restart and detail permalinks keep working).

`getRequest` LEFT JOINs `transcript` onto `request`, never INNER: transcripts age out on `TRANSCRIPT_RETENTION_DAYS` (7) while requests keep `RETENTION_DAYS` (30), so for most of a request's life its transcript is legitimately gone. An INNER JOIN would make a three-week-old request 404 as though it never existed. `transcriptPresent` is how the page distinguishes "aged out" from "never captured".

Both methods follow the existing convention: fresh `db.prepare(...)` per call, every error caught by `fail()`, never throwing to a caller.

- [ ] **Step 1: Write the failing test**

Add to `server/db.test.ts`:

```ts
/** A request row with sensible defaults; override what a test cares about. */
function req(requestId: string, ts: number, over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId, targetId: 'qwen', runId: null, ts,
    model: 'qwen', promptTokens: 15, completionTokens: 9,
    ttftS: 0.39, requestElapsedS: 0.6, decodeTokS: 36.7,
    clientLabel: 'node', toolCallCount: 0, userPreview: 'hi there',
    outcome: 'succeeded', statusCode: 200, streamed: false,
    finishReason: 'stop', engineJoined: true, ...over,
  };
}

test('queryRequests returns newest first and honours the limit', () => {
  const { store, cleanup } = tmpStore();
  for (let i = 0; i < 5; i++) store.insertRequestRow(req(`r${i}`, 1000 + i * 100));
  const rows = store.queryRequests('qwen', 3, null);
  assert.deepEqual(rows.map(r => r.requestId), ['r4', 'r3', 'r2']);
  cleanup();
});

test('queryRequests pages with `before`', () => {
  const { store, cleanup } = tmpStore();
  for (let i = 0; i < 5; i++) store.insertRequestRow(req(`r${i}`, 1000 + i * 100));
  const page = store.queryRequests('qwen', 2, 1300);
  assert.deepEqual(page.map(r => r.requestId), ['r2', 'r1']);
  cleanup();
});

test('queryRequests is scoped to one target', () => {
  const { store, cleanup } = tmpStore();
  store.insertRequestRow(req('a', 1000));
  store.insertRequestRow(req('b', 1001, { targetId: 'gemma' }));
  assert.deepEqual(store.queryRequests('qwen', 10, null).map(r => r.requestId), ['a']);
  cleanup();
});

test('queryRequests maps integer flags back to booleans', () => {
  const { store, cleanup } = tmpStore();
  store.insertRequestRow(req('a', 1000, { streamed: true, engineJoined: false }));
  const [row] = store.queryRequests('qwen', 10, null);
  assert.equal(row.streamed, true);
  assert.equal(row.engineJoined, false);
  cleanup();
});

test('getRequest returns the row with its transcript', () => {
  const { store, cleanup } = tmpStore();
  store.insertRequestRow(req('a', 1000));
  store.insertTranscript('a', '[{"role":"user","content":"hi"}]', 'hello', null, false);
  const d = store.getRequest('a');
  assert.equal(d?.requestId, 'a');
  assert.equal(d?.responseText, 'hello');
  assert.equal(d?.transcriptPresent, true);
  assert.equal(d?.truncated, false);
  cleanup();
});

/* Transcripts age out at 7 days while requests keep 30, so for most of a
   request's life its transcript is legitimately absent. An INNER JOIN would
   404 a three-week-old request as if it had never existed. */
test('getRequest still returns a request whose transcript has aged out', () => {
  const { store, cleanup } = tmpStore();
  store.insertRequestRow(req('a', 1000));
  const d = store.getRequest('a');
  assert.equal(d?.requestId, 'a');
  assert.equal(d?.transcriptPresent, false);
  assert.equal(d?.messages, null);
  assert.equal(d?.responseText, null);
  cleanup();
});

test('getRequest reports a truncated transcript as truncated', () => {
  const { store, cleanup } = tmpStore();
  store.insertRequestRow(req('a', 1000));
  store.insertTranscript('a', '[]', 'cut short', null, true);
  assert.equal(store.getRequest('a')?.truncated, true);
  cleanup();
});

test('getRequest returns null for an unknown id without degrading the store', () => {
  const { store, cleanup } = tmpStore();
  assert.equal(store.getRequest('nope'), null);
  assert.equal(store.status().ok, true);
  cleanup();
});

test('a disabled store answers both queries inertly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtplx-db-'));
  const store = createStore({ path: path.join(dir, 'h.db'), enabled: false, retentionDays: 30, transcriptRetentionDays: 7 });
  assert.deepEqual(store.queryRequests('qwen', 10, null), []);
  assert.equal(store.getRequest('a'), null);
  assert.equal(store.status().ok, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

Add `RequestRow` to `db.test.ts`'s type import if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/db.test.ts`
Expected: FAIL — `store.queryRequests is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/db.ts` — the interfaces next to `RequestRow`, the methods on `SqliteStore`, and both signatures on the `Store` interface:

```ts
export interface RequestSummary {
  requestId: string;
  ts: number;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  ttftS: number | null;
  requestElapsedS: number | null;
  decodeTokS: number | null;
  clientLabel: string | null;
  toolCallCount: number | null;
  userPreview: string | null;
  outcome: string | null;
  statusCode: number | null;
  streamed: boolean;
  finishReason: string | null;
  /** False when the Δcount == 1 join was ambiguous, so ttftS/decodeTokS are
   *  the proxy's wall-clock view rather than the engine's own measurement. */
  engineJoined: boolean;
}

export interface RequestDetail extends RequestSummary {
  runId: number | null;
  messages: string | null;
  responseText: string | null;
  tools: string | null;
  truncated: boolean;
  /** Distinguishes "aged out after TRANSCRIPT_RETENTION_DAYS" from "never
   *  captured" — a streamed request has a row but never has a transcript. */
  transcriptPresent: boolean;
}

const REQUEST_COLUMNS = `
  request_id, ts, model, prompt_tokens, completion_tokens, ttft_s,
  request_elapsed_s, decode_tok_s, client_label, tool_call_count,
  user_preview, outcome, status_code, streamed, finish_reason, engine_joined`;

interface RawRequestRow {
  request_id: string; ts: number; model: string | null;
  prompt_tokens: number | null; completion_tokens: number | null;
  ttft_s: number | null; request_elapsed_s: number | null; decode_tok_s: number | null;
  client_label: string | null; tool_call_count: number | null; user_preview: string | null;
  outcome: string | null; status_code: number | null; streamed: number | null;
  finish_reason: string | null; engine_joined: number | null;
}

function toSummary(r: RawRequestRow): RequestSummary {
  return {
    requestId: r.request_id, ts: r.ts, model: r.model,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens,
    ttftS: r.ttft_s, requestElapsedS: r.request_elapsed_s, decodeTokS: r.decode_tok_s,
    clientLabel: r.client_label, toolCallCount: r.tool_call_count,
    userPreview: r.user_preview, outcome: r.outcome, statusCode: r.status_code,
    streamed: r.streamed === 1, finishReason: r.finish_reason,
    engineJoined: r.engine_joined === 1,
  };
}
```

```ts
  queryRequests(targetId: string, limit: number, before: number | null): RequestSummary[] {
    if (!this.db) return [];
    try {
      const rows = (before === null
        ? this.db
            .prepare(`SELECT ${REQUEST_COLUMNS} FROM request WHERE target_id = ? ORDER BY ts DESC LIMIT ?`)
            .all(targetId, limit)
        : this.db
            .prepare(`SELECT ${REQUEST_COLUMNS} FROM request WHERE target_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`)
            .all(targetId, before, limit)) as unknown as RawRequestRow[];
      return rows.map(toSummary);
    } catch (err) {
      this.fail('queryRequests', err);
      return [];
    }
  }

  getRequest(requestId: string): RequestDetail | null {
    if (!this.db) return null;
    try {
      /* LEFT JOIN, never INNER: transcripts age out on their own retention
         while the request row lives three times longer, so an absent
         transcript is the normal case, not a missing request. */
      const row = this.db
        .prepare(
          `SELECT ${REQUEST_COLUMNS}, request.run_id AS run_id,
                  transcript.messages AS messages,
                  transcript.response_text AS response_text,
                  transcript.tools AS tools,
                  transcript.truncated AS truncated,
                  transcript.request_id IS NOT NULL AS transcript_present
             FROM request LEFT JOIN transcript USING (request_id)
            WHERE request.request_id = ?`
        )
        .get(requestId) as
        | (RawRequestRow & {
            run_id: number | null; messages: string | null; response_text: string | null;
            tools: string | null; truncated: number | null; transcript_present: number;
          })
        | undefined;
      if (!row) return null;
      return {
        ...toSummary(row),
        runId: row.run_id,
        messages: row.messages,
        responseText: row.response_text,
        tools: row.tools,
        truncated: row.truncated === 1,
        transcriptPresent: row.transcript_present === 1,
      };
    } catch (err) {
      this.fail('getRequest', err);
      return null;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/db.test.ts`
Expected: PASS — 51 existing plus 9 new.

Then `npm test` — expected 146/146 (108 existing + 18 from Task 1 + 11 from Task 2 + these 9).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add server/db.ts server/db.test.ts
git commit -m "feat: request and detail queries for the restored log pages"
```

---

## Task 4: The capture proxy

**Files:**
- Modify: `server/config.ts`, `.env.example`
- Create: `server/proxy.ts`
- Test: `server/proxy.test.ts`

**Interfaces:**
- Consumes: `Target` from `./targets`; `Store`, `RequestRow` from `./db`; `EngineJoin` from `./engineJoin`; everything from `./capture`; `config` from `./config`.
- Produces:
  - `interface ProxyDeps { target: Target; store: Pick<Store, 'insertRequestRow' | 'insertTranscript'>; join: EngineJoin; runId: () => number | null; onCaptured: (ts: number) => void; onUpstream: (ok: boolean) => void }`
  - `function start(deps: ProxyDeps): void`
  - `function stop(): void`
  - `function listening(): boolean`

**Background you need — read all of it before writing a line.**

This module sits in gbrain's inference path, including the unattended 07:05 nightly dream. Everything below is a rule, not a preference.

**No timeout on the forward path.** gbrain deliberately does not time out local inference calls, because a cold-cache 35B MoE can legitimately take minutes. Do not set `timeout` on the upstream request, do not call `setTimeout` on its socket, and do not reuse `config.scrapeTimeoutMs` — that budget is 2500 ms and exists only for scraping `/metrics`.

**Forward first, capture second.** The client's bytes must not wait on anything we do. Capture is a *tee*: the same `data` handler that writes to the client also pushes into an accumulator. Never buffer the whole response and then forward it — that adds latency proportional to response size, in the one path this project exists to measure.

**Never synthesize, never retry.** Upstream status, headers and body pass through verbatim, errors included. A retried non-idempotent completion double-bills compute and corrupts the engine's counters. The single exception is a connection-level failure, where there is no upstream response to relay: answer `502` and record `outcome: 'failed'`.

**Capture can never break a completion.** Every parse, join and persist call is wrapped. A store that throws, a body that will not parse, a join that never settles — all of them degrade to a missing or partial log row.

**Streaming pipes straight through** with no body accumulation and no engine join, but still records a row (design decision D3): id, timestamp, model, elapsed, `streamed = 1`, outcome, status. A streaming client that recorded nothing would read as "no traffic" rather than "traffic we do not introspect".

**Only `POST /v1/chat/completions` is captured.** Everything else — `/v1/models`, `/health`, `/v1/status` — is pure pass-through, because it carries no request identity worth a row.

**Hop-by-hop headers must be dropped** when forwarding (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailers`, `transfer-encoding`, `upgrade`) and `host` rewritten to the upstream. Forwarding `connection: keep-alive` to a different socket is how a proxy corrupts connection reuse.

- [ ] **Step 1: Add the config this task consumes**

`proxy.ts` reads `config.transcriptMaxBytes`, so it must exist before the module compiles. Add both new keys to `server/config.ts`'s frozen object now (Task 6 wires `captureEnabled` into startup; only the value is needed here):

```ts
  /** Escape hatch: false unbinds the proxy listener entirely and returns the
   *  dashboard to Phase 1 behaviour (scrape only), without a code change. */
  captureEnabled: bool('CAPTURE_ENABLED', true),
  /** Per-field cap on stored transcript bodies. Counted in BYTES — a character
   *  budget would let a CJK transcript through at roughly three times the cap. */
  transcriptMaxBytes: int('TRANSCRIPT_MAX_BYTES', 262144),
```

Document both in `.env.example`, and note there that the forward path has no timeout by design.

- [ ] **Step 2: Write the failing test**

Create `server/proxy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EngineJoin } from './engineJoin';
import type { RequestRow } from './db';
import * as proxy from './proxy';

/** A stub upstream whose behaviour each test controls. */
function stubUpstream(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void>; seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] }> {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>(r => srv.close(() => r())),
      });
    });
  });
}

/** Captures what the proxy tried to persist. */
function recordingStore() {
  const rows: RequestRow[] = [];
  const transcripts: { requestId: string; messages: string | null; responseText: string | null; truncated: boolean }[] = [];
  return {
    rows, transcripts,
    insertRequestRow: (r: RequestRow) => { rows.push(r); },
    insertTranscript: (requestId: string, messages: string | null, responseText: string | null, _tools: string | null, truncated: boolean) =>
      { transcripts.push({ requestId, messages, responseText, truncated }); },
  };
}

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** POSTs to the proxy and resolves with the full client-visible response. */
function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const COMPLETION = {
  id: 'chatcmpl-1', object: 'chat.completion', model: 'qwen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi! How can I help?' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 },
};

async function withProxy(
  upstreamHandler: http.RequestListener,
  fn: (ctx: { port: number; store: ReturnType<typeof recordingStore>; join: EngineJoin; up: Awaited<ReturnType<typeof stubUpstream>> }) => Promise<void>,
  opts: { upstreamUrl?: string } = {}
) {
  const up = await stubUpstream(upstreamHandler);
  const port = await freePort();
  const store = recordingStore();
  const join = new EngineJoin();
  proxy.start({
    target: { id: 'qwen', label: 'qwen', upstreamUrl: opts.upstreamUrl ?? up.url, proxyPort: port },
    store, join, runId: () => 7, onCaptured: () => {}, onUpstream: () => {},
  });
  try {
    await fn({ port, store, join, up });
  } finally {
    proxy.stop();
    await up.close();
  }
}

/** The capture path is async (it awaits the engine join); give it a beat. */
const settled = () => new Promise(r => setTimeout(r, 60));

test('forwards the request and returns the upstream response verbatim', async () => {
  await withProxy((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-rapid-mlx': 'yes' });
    res.end(JSON.stringify(COMPLETION));
  }, async ({ port, up }) => {
    const r = await post(port, '/v1/chat/completions', { model: 'qwen', messages: [{ role: 'user', content: 'hi there' }] });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).choices[0].message.content, 'Hi! How can I help?');
    assert.equal(r.headers['x-rapid-mlx'], 'yes', 'upstream headers must survive');
    assert.equal(up.seen[0].method, 'POST');
    assert.equal(up.seen[0].url, '/v1/chat/completions');
    assert.equal(JSON.parse(up.seen[0].body).messages[0].content, 'hi there');
  });
});

test('hop-by-hop headers are not forwarded and host is rewritten', async () => {
  await withProxy((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(COMPLETION)); },
    async ({ port, up }) => {
      await post(port, '/v1/chat/completions', { messages: [] }, { connection: 'keep-alive', 'proxy-authorization': 'secret' });
      assert.equal(up.seen[0].headers['proxy-authorization'], undefined);
      assert.notEqual(up.seen[0].headers.host, `127.0.0.1:${port}`, 'host must name the upstream, not the proxy');
    });
});

test('records a request row and a transcript for a captured completion', async () => {
  await withProxy((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(COMPLETION)); },
    async ({ port, store, join }) => {
      await post(port, '/v1/chat/completions', { model: 'qwen', messages: [{ role: 'user', content: 'hi there' }] }, { 'user-agent': 'node' });
      join.settle(1, { ttftS: 0.39, decodeTokS: 36.7 });
      await settled();

      assert.equal(store.rows.length, 1);
      const row = store.rows[0];
      assert.match(row.requestId, /^[A-Za-z0-9_-]{8,}$/);
      assert.equal(row.targetId, 'qwen');
      assert.equal(row.runId, 7);
      assert.equal(row.promptTokens, 15);
      assert.equal(row.completionTokens, 9);
      assert.equal(row.outcome, 'succeeded');
      assert.equal(row.statusCode, 200);
      assert.equal(row.streamed, false);
      assert.equal(row.finishReason, 'stop');
      assert.equal(row.userPreview, 'hi there');
      assert.equal(row.clientLabel, 'node');
      assert.equal(row.ttftS, 0.39, 'engine-joined TTFT');
      assert.equal(row.engineJoined, true);
      assert.ok((row.requestElapsedS ?? 0) >= 0);

      assert.equal(store.transcripts.length, 1);
      assert.equal(store.transcripts[0].responseText, 'Hi! How can I help?');
      assert.equal(store.transcripts[0].truncated, false);
    });
});

/* Δcount > 1 means the engine's numbers are a mean over several requests. */
test('an ambiguous join stores engineJoined false and no engine TTFT', async () => {
  await withProxy((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(COMPLETION)); },
    async ({ port, store, join }) => {
      await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
      join.settle(4, { ttftS: 0.5, decodeTokS: 30 });
      await settled();
      assert.equal(store.rows[0].engineJoined, false);
      assert.equal(store.rows[0].ttftS, null);
      assert.equal(store.rows[0].decodeTokS, null);
    });
});

test('an upstream error passes through verbatim and is recorded as failed', async () => {
  await withProxy((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'context length exceeded' } }));
  }, async ({ port, store, join }) => {
    const r = await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error.message, 'context length exceeded', 'body must not be rewritten');
    join.settle(0, { ttftS: null, decodeTokS: null });
    await settled();
    assert.equal(store.rows[0].outcome, 'failed');
    assert.equal(store.rows[0].statusCode, 400);
  });
});

/* A connection-level failure is the ONE case with no upstream response to
   relay, so it is the one case the proxy may answer itself. */
test('an unreachable upstream yields 502 and a failed row, and never retries', async () => {
  const dead = await stubUpstream(() => {});
  const deadUrl = dead.url;
  await dead.close();
  await withProxy(() => {}, async ({ port, store }) => {
    const r = await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 502);
    await settled();
    assert.equal(store.rows[0].outcome, 'failed');
  }, { upstreamUrl: deadUrl });
});

test('a streamed response is piped through, recorded, and never transcribed', async () => {
  await withProxy((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }, async ({ port, store }) => {
    const r = await post(port, '/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200);
    assert.match(r.body, /\[DONE\]/, 'the stream must reach the client intact');
    await settled();
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].streamed, true);
    assert.equal(store.rows[0].engineJoined, false);
    assert.equal(store.transcripts.length, 0, 'streamed requests are not transcribed');
  });
});

test('paths other than chat completions pass through without a row', async () => {
  await withProxy((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); },
    async ({ port, store }) => {
      const r = await post(port, '/v1/models', {});
      assert.equal(r.status, 200);
      await settled();
      assert.equal(store.rows.length, 0);
    });
});

/* The whole point of "forward first, capture second". */
test('a store that throws does not affect the client response', async () => {
  const up = await stubUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(COMPLETION)); });
  const port = await freePort();
  const join = new EngineJoin();
  proxy.start({
    target: { id: 'qwen', label: 'qwen', upstreamUrl: up.url, proxyPort: port },
    store: {
      insertRequestRow: () => { throw new Error('disk full'); },
      insertTranscript: () => { throw new Error('disk full'); },
    },
    join, runId: () => null, onCaptured: () => {}, onUpstream: () => {},
  });
  try {
    const r = await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).choices[0].message.content, 'Hi! How can I help?');
    join.settle(1, { ttftS: 0.1, decodeTokS: 1 });
    await settled();
  } finally {
    proxy.stop();
    await up.close();
  }
});

/* config.scrapeTimeoutMs is 2500ms and must never bind the forward path —
   gbrain does not time out local inference at all. */
test('a slow upstream is not timed out', async () => {
  await withProxy((_req, res) => {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(COMPLETION)); }, 3200);
  }, async ({ port }) => {
    const started = Date.now();
    const r = await post(port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, 'a 3.2s upstream must not be cut off by the 2.5s scrape budget');
    assert.ok(Date.now() - started >= 3000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/proxy.test.ts`
Expected: FAIL — `Cannot find module './proxy'`.

- [ ] **Step 4: Write the implementation**

Create `server/proxy.ts`:

```ts
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
  /** Current run id, for tagging rows. Read at completion, not at start. */
  runId: () => number | null;
  /** Fired after a row is persisted, so the dashboard can refresh its log. */
  onCaptured: (ts: number) => void;
  /** Forward-path health — independent of scrapeOk (spec section 7). */
  onUpstream: (ok: boolean) => void;
}

/* Hop-by-hop headers are meaningful to ONE connection. Forwarding them onto a
   different socket is how a proxy corrupts connection reuse. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

const CAPTURE_PATH = '/v1/chat/completions';
/** Stop accumulating past this; a pathological response must not be held in
 *  memory just to be parsed. Larger than any real completion. */
const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

let server: http.Server | null = null;
let deps: ProxyDeps | null = null;

function upstreamOptions(req: http.IncomingMessage, base: URL): http.RequestOptions {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = base.host;
  return {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port,
    method: req.method,
    path: req.url,
    headers,
  };
}

/** Reads a bounded request body. Returns null once the cap is passed — the
 *  bytes still forward, we simply stop keeping them for capture. */
function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', c => {
      size += (c as Buffer).length;
      if (size > cap) { over = true; chunks.length = 0; return; }
      chunks.push(c as Buffer);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

async function persist(
  d: ProxyDeps,
  row: RequestRow,
  transcript: { messages: string | null; responseText: string | null; tools: string | null; truncated: boolean } | null
): Promise<void> {
  /* Wrapped whole: the completion has already been delivered, and nothing here
     may surface to the client. */
  try {
    d.store.insertRequestRow(row);
    if (transcript) {
      d.store.insertTranscript(row.requestId, transcript.messages, transcript.responseText, transcript.tools, transcript.truncated);
    }
    d.onCaptured(row.ts);
  } catch {
    /* db.ts already catches and degrades; this is the belt for anything else. */
  }
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const d = deps;
  if (!d) { res.writeHead(503).end(); return; }

  const base = new URL(d.target.upstreamUrl);
  const startedAt = Date.now();
  const captureThis = req.method === 'POST' && (req.url ?? '').startsWith(CAPTURE_PATH);

  void readBody(req, CAPTURE_MAX_BYTES).then(reqBody => {
    const parsedReq = captureThis && reqBody ? safe(() => parseRequestBody(reqBody)) : null;
    const streamed = parsedReq?.streamed === true;

    const upstream = http.request(upstreamOptions(req, base), upRes => {
      d.onUpstream(true);

      /* Verbatim: status, and every header the upstream sent. */
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);

      const chunks: Buffer[] = [];
      let size = 0;
      const collecting = captureThis && !streamed;

      upRes.on('data', chunk => {
        /* Tee: the client gets the bytes on this same handler, so capture
           costs no latency. Never buffer-then-forward. */
        res.write(chunk);
        if (collecting) {
          size += (chunk as Buffer).length;
          if (size <= CAPTURE_MAX_BYTES) chunks.push(chunk as Buffer);
        }
      });

      upRes.on('end', () => {
        res.end();
        if (!captureThis) return;
        void capture(d, {
          startedAt, statusCode: upRes.statusCode ?? 0, streamed,
          parsedReq, responseBuf: collecting && size <= CAPTURE_MAX_BYTES ? Buffer.concat(chunks) : null,
          userAgent: req.headers['user-agent'],
        });
      });

      upRes.on('error', () => { res.destroy(); });
    });

    /* No timeout, deliberately: gbrain does not time out local inference and a
       cold-cache 35B MoE can legitimately run for minutes. config.scrapeTimeoutMs
       is 2500ms and belongs to the scrape path alone. */
    upstream.on('error', () => {
      d.onUpstream(false);
      /* The one case with no upstream response to relay. Answer, never retry —
         a retried completion double-bills compute and corrupts the counters. */
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream unreachable', type: 'proxy_error' } }));
      if (captureThis) {
        void capture(d, { startedAt, statusCode: 502, streamed, parsedReq, responseBuf: null, userAgent: req.headers['user-agent'] });
      }
    });

    /* The client hung up mid-flight: stop the upstream rather than paying for
       a completion nobody will read. */
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });

    if (reqBody) upstream.end(reqBody);
    else req.pipe(upstream);
  });
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

async function capture(
  d: ProxyDeps,
  ctx: {
    startedAt: number; statusCode: number; streamed: boolean;
    parsedReq: ReturnType<typeof parseRequestBody>;
    responseBuf: Buffer | null;
    userAgent: string | undefined;
  }
): Promise<void> {
  const ts = Date.now();
  const elapsedS = (ts - ctx.startedAt) / 1000;
  const parsedRes = ctx.responseBuf ? safe(() => parseResponseBody(ctx.responseBuf!)) : null;

  /* A streamed request is never joined — the engine's interval delta covers it
     but we deliberately do not transcribe or attribute it (spec section 7). */
  const engine = ctx.streamed || ctx.statusCode >= 400 ? null : await d.join.claim();

  const row: RequestRow = {
    requestId: newRequestId(),
    targetId: d.target.id,
    runId: d.runId(),
    ts,
    model: ctx.parsedReq?.model ?? null,
    promptTokens: parsedRes?.promptTokens ?? null,
    completionTokens: parsedRes?.completionTokens ?? null,
    ttftS: engine?.ttftS ?? null,
    requestElapsedS: elapsedS,
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

  /* Streamed responses are never transcribed; a failed one has no transcript
     worth keeping either. */
  let transcript = null as Parameters<typeof persist>[2];
  if (!ctx.streamed && parsedRes) {
    const messages = safe(() => (ctx.parsedReq?.messages ? JSON.stringify(ctx.parsedReq.messages) : null));
    const tools = safe(() => (ctx.parsedReq?.tools ? JSON.stringify(ctx.parsedReq.tools) : null));
    const m = truncate(messages, config.transcriptMaxBytes);
    const r = truncate(parsedRes.responseText, config.transcriptMaxBytes);
    transcript = { messages: m.value, responseText: r.value, tools, truncated: m.truncated || r.truncated };
  }

  await persist(d, row, transcript);
}

export function start(d: ProxyDeps): void {
  if (!d.target.proxyPort) return;   // no proxy port configured for this target
  deps = d;
  server = http.createServer(handle);
  server.listen(d.target.proxyPort, '127.0.0.1', () => {
    console.log(`capture proxy listening on :${d.target.proxyPort} → ${d.target.upstreamUrl}`);
  });
}

export function stop(): void {
  deps?.join.abandon();
  server?.close();
  server = null;
  deps = null;
}

export function listening(): boolean {
  return server !== null && server.listening;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/proxy.test.ts`
Expected: PASS, 10 tests. The slow-upstream test takes ~3.2 s by design — that is the assertion.

Then `npm test` — expected 156/156 (146 + these 10).

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add server/config.ts .env.example server/proxy.ts server/proxy.test.ts
git commit -m "feat: capture proxy with tee capture and verbatim pass-through"
```

---

## Task 5: Scraper settles the join, and owns upstreamOk

**Files:**
- Modify: `server/promScraper.ts`
- Test: `server/promScraper.test.ts`

**Interfaces:**
- Consumes: `EngineJoin` from `./engineJoin`.
- Produces: `start(target: Target, store: Store, join: EngineJoin): void`, `setUpstreamOk(ok: boolean): void`, and `getSnapshot()` now returning a real `upstreamOk` plus `lastRequestAt`.

**Background you need:** The scraper already computes `deriveSamples()` on every successful tick, producing `completedDelta`, `decode` and `ttft`. Those are exactly the three values `EngineJoin.settle()` needs, so settling is one call in a place that already exists.

Two ordering rules:
- **Settle after `runTracker.observe()` and after the restart check.** A restart resets the counters; any waiter registered before it belongs to the dead process and must be abandoned, not handed a post-restart sample.
- **Settle only on a successful scrape.** A failed scrape has no delta, and calling `settle(null, …)` on every failure would age out waiters during an outage that is not their fault. The existing `catch` branch must not settle.

`upstreamOk` is the forward-path health the proxy reports (spec §7): independent of `scrapeOk`, because a failed scrape says nothing about whether inference is serving. It starts `null` — meaning "no proxied request has been seen yet", which is different from `false`.

- [ ] **Step 1: Write the failing test**

Add to `server/promScraper.test.ts`:

```ts
import { EngineJoin } from './engineJoin';

/* deriveSamples already yields exactly what settle() needs; this pins the
   wiring so a future edit cannot quietly stop feeding the join. */
test('a tick with one completion settles a waiting claim with the engine sample', async () => {
  const c = new CounterState();
  const join = new EngineJoin();
  const claim = join.claim();

  deriveSamples(parsePrometheus(COLD), c);
  const d = deriveSamples(parsePrometheus(AFTER), c);
  join.settle(d.completedDelta, { ttftS: d.ttft, decodeTokS: d.decode });

  const s = await claim;
  assert.ok(s !== null);
  assert.equal(s.decodeTokS, 36.726379);
  assert.ok(s.ttftS !== null && Math.abs(s.ttftS - 0.393659) < 1e-9);
});

test('a quiet tick leaves the claim pending', async () => {
  const c = new CounterState();
  const join = new EngineJoin();
  join.claim();
  deriveSamples(parsePrometheus(AFTER), c);
  const d = deriveSamples(parsePrometheus(AFTER), c);   // nothing advanced
  join.settle(d.completedDelta, { ttftS: d.ttft, decodeTokS: d.decode });
  assert.equal(join.pending(), 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promScraper.test.ts`
Expected: FAIL — `EngineJoin` is not imported / `deriveSamples` returns a shape the call does not match.

- [ ] **Step 3: Write the implementation**

In `server/promScraper.ts`:

```ts
import type { EngineJoin } from './engineJoin';

let join: EngineJoin | null = null;
/** Forward-path health. null = no proxied request seen yet, which is a
 *  different statement from false. Independent of scrapeOk (spec section 7). */
let upstreamOk: boolean | null = null;
let lastRequestAt: number | null = null;
```

Inside `pollOnce`, immediately after the restart check that calls `counters.reset()`:

```ts
    if (runTracker?.didRestart()) {
      counters.reset();
      lastPersisted.clear();
      /* Waiters registered before the restart belong to the dead process; the
         post-restart sample is not theirs to receive. */
      join?.abandon();
    }

    const d = deriveSamples(s, counters);
    /* Settle only on a successful scrape. Settling on failure would age
       waiters out during an outage that has nothing to do with them. */
    join?.settle(d.completedDelta, { ttftS: d.ttft, decodeTokS: d.decode });
```

Add the setters and extend `getSnapshot()`:

```ts
export function setUpstreamOk(ok: boolean): void {
  if (ok === upstreamOk) return;
  upstreamOk = ok;
  broadcastTick(getSnapshot());   // forward-path state changed: tell the pages
}

export function noteRequest(ts: number): void {
  lastRequestAt = ts;
  broadcastTick(getSnapshot());
}
```

In `getSnapshot()`, replace the hardcoded `upstreamOk: null` with `upstreamOk` and add `lastRequestAt`.

Change the signature to `export function start(t: Target, s: Store, j: EngineJoin): void` and assign `join = j`. In `stop()`, add `join?.abandon(); join = null;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --import tsx --test server/promScraper.test.ts`
Expected: PASS, 9 tests (7 existing + 2 new). `npm test` — expected 158/158.

Note `npm run typecheck` will now fail in `server/server.ts` (it calls `scraper.start` with two arguments). That is expected and is fixed in Task 6. Do not modify `server.ts` here.

- [ ] **Step 5: Commit**

```bash
git add server/promScraper.ts server/promScraper.test.ts
git commit -m "feat: scraper settles the engine join and owns upstreamOk"
```

---

## Task 6: Config, payload and server wiring

**Files:**
- Modify: `server/types.ts`, `server/server.ts`

**Interfaces:**
- Consumes: `config.captureEnabled` and `config.transcriptMaxBytes`, both added in Task 4.
- Produces: `StatePayload.upstreamOk: boolean | null` (real) and `StatePayload.lastRequestAt: number | null`; `GET /api/requests`, `GET /api/requests/:id`.

**Background you need:** This is the task where the proxy actually goes into the path. `captureEnabled` exists as an escape hatch: if capture ever misbehaves in production the proxy can be disabled by env var without editing code or reverting a commit — set it false and the dashboard returns to Phase 1 behaviour, still scraping, no listener bound.

`/api/requests` is the log page's data source (design decision D5). It takes `target`, `limit` (clamped) and `before` for paging. `/api/requests/:id` backs the detail permalink.

- [ ] **Step 1: Extend the payload**

In `server/types.ts`, replace the `upstreamOk` comment (it currently says "always null in this phase") with:

```ts
  /** Capture-proxy forward-path health. null until a request has been
   *  proxied — "unknown" is not "down". Independent of scrapeOk: a failed
   *  scrape says nothing about whether inference is serving. */
  upstreamOk: boolean | null;
  /** Wall-clock ms of the most recently captured request, so the log page
   *  knows when to refetch without the payload carrying the log itself. */
  lastRequestAt: number | null;
```

- [ ] **Step 2: Wire the server**

In `server/server.ts`:

```ts
import * as proxy from './proxy';
import { EngineJoin } from './engineJoin';

const join = new EngineJoin();
```

Add the two endpoints alongside the existing history routes:

```ts
app.get('/api/requests', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const raw = Number.parseInt(String(q.limit ?? ''), 10);
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, raw)) : 50;
  const beforeRaw = Number.parseInt(String(q.before ?? ''), 10);
  const before = Number.isFinite(beforeRaw) ? beforeRaw : null;
  res.json({ requests: store.queryRequests(queryTarget(q), limit, before) });
});

app.get('/api/requests/:id', (req, res) => {
  const detail = store.getRequest(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'request not found' });
    return;
  }
  res.json(detail);
});
```

Start the proxy after the scraper, and pass the join to both:

```ts
void healthPoller.start(target).then(() => {
  if (shuttingDown) return;
  scraper.start(target, store, join);
  if (config.captureEnabled) {
    proxy.start({
      target,
      store,
      join,
      runId: () => scraper.getRunId(),
      onCaptured: ts => scraper.noteRequest(ts),
      onUpstream: ok => scraper.setUpstreamOk(ok),
    });
  }
});
```

Add `getRunId()` to `promScraper.ts` returning `runTracker?.getRunId() ?? null`.

In `shutdown()`, stop the proxy first — it is the thing gbrain is talking to, and it should stop accepting before the store closes underneath it:

```ts
function shutdown(): void {
  shuttingDown = true;
  proxy.stop();
  clearInterval(heartbeat);
  ...
```

Update the boot log to name the proxy port when capture is enabled.

- [ ] **Step 3: Verify**

```bash
npm run typecheck    # expected clean
npm test             # expected 158/158
npm run build        # expected clean
```

Then run it against the real server. rapid-mlx is on `:8000`; the proxy will bind `:8010`.

```bash
npm run dev
```

Send a completion **through the proxy** rather than directly:

```bash
curl -s http://127.0.0.1:8010/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"mtplx-qwen38-27b-optimized-speed-fp16","messages":[{"role":"user","content":"Say hi."}],"max_tokens":16}'
```

Confirm the completion comes back normally, then:

```bash
curl -s 'http://127.0.0.1:8123/api/requests?limit=5' | head -c 600
sqlite3 data/history.db "SELECT request_id, model, prompt_tokens, completion_tokens, ttft_s, decode_tok_s, engine_joined, outcome FROM request;"
sqlite3 data/history.db "SELECT request_id, length(messages), length(response_text), truncated FROM transcript;"
```

Expected: one `request` row with real token counts, `outcome` `succeeded`, and — because a single request completed in that interval — `engine_joined` `1` with a non-null `ttft_s`. One `transcript` row with both bodies present.

Also confirm pass-through of a non-captured path: `curl -s http://127.0.0.1:8010/v1/models | head -c 200` should return the model list with no new `request` row.

**Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add server/types.ts server/server.ts
git commit -m "feat: wire the capture proxy and request endpoints into the server"
```

---

## Task 7: Restore the live log page

**Files:**
- Modify: `public/log.html`, `public/index.html`

**Background you need:** Phase 1 turned this page into a static panel explaining that rapid-mlx exposes no per-request identity. That is no longer true — the proxy provides it. Replace the panel with a real feed.

Unlike the MTPLX era, the data comes from **SQLite via `/api/requests`**, not from a server-side in-memory ring (design decision D5). Consequences worth building around: the log survives a dashboard restart, paging is real (`before`), and the SSE connection is only a *hint* — the page subscribes to ticks and refetches when `lastRequestAt` advances, rather than receiving rows over SSE.

Rendering and formatting stay duplicated in this file per the project convention. Match `index.html`'s CSS token block exactly.

Columns worth showing, given what Phase 2 can actually know: time, model, client, preview, prompt/completion tokens, TTFT, decode tok/s, elapsed, outcome. Rows link to `detail.html?id=<request_id>`.

Two honesty requirements:
- A row with `engineJoined: false` must not present `ttftS`/`decodeTokS` as engine measurements — they are null in that case, so render `—` and mark the row so a reader can tell "ambiguous interval" from "not measured".
- A `streamed: true` row has no transcript and no engine join by design. Label it rather than letting it look like a failed capture.

- [ ] **Step 1: Rebuild the page**

Remove the static explanatory `<section>` and the Phase 1 wording. Build:

- a table fed by `GET /api/requests?limit=50`
- an `EventSource('/api/events')` subscription that refetches when the payload's `lastRequestAt` changes (throttle to at most one refetch per second — an idle server ticks on `scrapeOk` changes too)
- a "load older" control that pages with `before=<oldest ts on screen>`
- the two-dimensional connection banner: `scrapeOk` and `upstreamOk` are independent, so the banner must say *which* is down. `upstreamOk === null` means "no request proxied yet" and must not render as an outage.
- an empty state that distinguishes "no requests captured yet" from "capture is disabled" (`captureEnabled` is not on the payload — infer from an empty result plus a hint in the copy, or leave the copy neutral)

- [ ] **Step 2: Give index.html the same two-dimensional banner**

Spec §7 requires the banner to say *which* dimension is down, and `index.html` currently treats `scrapeOk` alone as connectedness — so with the proxy live, a healthy inference path behind a failed scrape reads as a total outage, and a dead forward path reads as fine.

In `applyPayload()`, drive `body.disconnected` and the banner text from both fields:

```js
  /* Two independent dimensions (spec section 7). A failed scrape says nothing
     about whether inference is serving, and vice versa. upstreamOk === null
     means no request has been proxied yet — unknown is not down. */
  const scrapeDown = !p.scrapeOk;
  const upstreamDown = p.upstreamOk === false;
  connected = !scrapeDown && !upstreamDown;
  $('banner-what').textContent =
    scrapeDown && upstreamDown ? 'metrics scrape and inference forwarding are both failing'
    : scrapeDown ? 'metrics scrape failing — inference forwarding is unaffected'
    : upstreamDown ? 'inference forwarding failing — metrics are still being scraped'
    : '';
```

Add the `#banner-what` element to the banner markup. Keep the existing `#banner-time` behaviour.

- [ ] **Step 3: Verify**

```bash
npm run dev
```

Drive two requests through the proxy so the list has more than one row:

```bash
for i in 1 2; do curl -s http://127.0.0.1:8010/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"mtplx-qwen38-27b-optimized-speed-fp16","messages":[{"role":"user","content":"Say hi."}],"max_tokens":16}' > /dev/null; done
curl -s 'http://127.0.0.1:8123/api/requests?limit=5' | python3 -m json.tool | head -30
```

Then grep the served page for the ids your code references against ids present in the markup — in Phase 1 a module-scope throw from one missing element killed an entire page while every server-side check passed. Report the result.

**Visual verification is the controller's job.** Do not drive a browser. **Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add public/log.html public/index.html
git commit -m "feat: restore the live request log, and split the banner by dimension"
```

---

## Task 8: Restore the request detail page

**Files:**
- Modify: `public/detail.html`

**Background you need:** Same situation as Task 7 — this was a static panel and now has a real source, `GET /api/requests/:id`, reached as `detail.html?id=<request_id>`.

The subtlety here is **three distinct empty states, which must not collapse into one**:

1. **Unknown id** — the endpoint returns 404. The request never existed, or aged out past `RETENTION_DAYS` (30).
2. **Request exists, `transcriptPresent: false`** — either the transcript aged out past `TRANSCRIPT_RETENTION_DAYS` (7), or it was never captured because the request was streamed. The row's `streamed` flag distinguishes these, and the page must say which.
3. **Request exists, `truncated: true`** — the bodies are present but were cut at `TRANSCRIPT_MAX_BYTES`. Say so at the cut, rather than silently showing a partial prompt as if it were whole.

Getting these wrong is the failure this page exists to avoid: a reader concluding "the model was sent nothing" when the truth is "we stopped keeping it a week ago".

- [ ] **Step 1: Rebuild the page**

Read `id` from the query string, fetch the detail, and render: the metric summary (tokens, TTFT, decode, elapsed, outcome, finish reason, client, model, run id), then the prompt messages and the response text. Show `tools` when present. Handle all three empty states above explicitly, and render `engineJoined: false` as an explicit note that the interval covered several requests rather than as a missing measurement.

Keep the CSS token block in sync with `index.html`.

- [ ] **Step 2: Verify**

```bash
npm run dev
ID=$(curl -s 'http://127.0.0.1:8123/api/requests?limit=1' | python3 -c "import json,sys;print(json.load(sys.stdin)['requests'][0]['requestId'])")
curl -s "http://127.0.0.1:8123/api/requests/$ID" | python3 -m json.tool | head -30
curl -s -o /dev/null -w "detail page: %{http_code}\n" "http://127.0.0.1:8123/detail.html?id=$ID"
curl -s -o /dev/null -w "unknown id API: %{http_code}\n" "http://127.0.0.1:8123/api/requests/does-not-exist"
```

Expected: the detail JSON carries `messages` and `responseText`; the page serves 200; the unknown id returns 404. Run the same missing-element grep as Task 7 and report it.

**Stop the dev server when done.**

- [ ] **Step 3: Commit**

```bash
git add public/detail.html
git commit -m "feat: restore the request detail page with honest empty states"
```

---

## Task 9: Supervision, and the repoint runbook

**Files:**
- Create: `scripts/com.local.mtplx-dashboard.plist`
- Create: `scripts/install-launchd.sh`
- Modify: `README.md`

**Background you need:** Phase 2 puts this process in gbrain's inference path, including the unattended 07:05 nightly dream (`com.gbrain.dream-nightly`). Unsupervised, an unhandled rejection at 3am silently breaks that run and the first sign is a missing dream. Supervision converts it into a seconds-long blip.

Follow the conventions of the user's existing units — `~/Library/LaunchAgents/com.local.rapidmlx-server.plist` is the model: `KeepAlive`, `RunAtLoad`, `ProcessType Interactive`, `ThrottleInterval 30`, an explicit `PATH`, and stdout/stderr to files.

**You do NOT repoint gbrain.** Editing `~/.gbrain/config.json` changes the user's production setup, outside this repo, and it is the step that actually moves traffic onto the proxy. Write the runbook; the user runs it when they choose. Say so plainly in the README rather than implying the phase is complete without it.

- [ ] **Step 1: Write the launchd unit**

Create `scripts/com.local.mtplx-dashboard.plist`, modelled on the rapid-mlx units. It must run the **built** server (`npm start`, i.e. `node dist/server.js`), not `tsx watch` — a watcher in the inference path restarts on file changes.

Note in a comment (plists take no comments; put it in the install script's output instead) that `WorkingDirectory` must be the repo root so `data/history.db` resolves.

- [ ] **Step 2: Write the install script**

`scripts/install-launchd.sh` should: build (`npm run build`), copy the plist into `~/Library/LaunchAgents/`, `launchctl bootout` any previous instance, `launchctl bootstrap gui/$UID`, then print the verification commands and the gbrain repoint runbook. It must be idempotent and must not repoint anything itself.

- [ ] **Step 3: Document the repoint runbook in the README**

The runbook is three URL edits in `~/.gbrain/config.json`, and it is fully reversible:

```
"llm_base_url": "http://localhost:8000/v1"          →  "http://localhost:8010/v1"
"provider_base_urls.lmstudio": ".../8000/v1"        →  ".../8010/v1"
"provider_base_urls.openai":   ".../8000/v1"        →  ".../8010/v1"
```

Leave `mlx-gemma4` on `:8087` — the gemma backend gets its own proxy in Phase 3.

The README must state, in order: verify the proxy works with a direct curl *before* repointing; that reverting is the same three edits back; and that the 07:05 nightly dream is the unattended job most exposed if the dashboard is down, which is what the launchd unit exists to prevent.

- [ ] **Step 4: Verify**

```bash
npm run build
bash scripts/install-launchd.sh          # installs and loads
launchctl print gui/$UID/com.local.mtplx-dashboard | head -20
curl -s -o /dev/null -w "dashboard: %{http_code}\n" http://127.0.0.1:8123/
curl -s -o /dev/null -w "proxy passthrough: %{http_code}\n" http://127.0.0.1:8010/v1/models
```

Then prove supervision actually works — kill the process and confirm it comes back:

```bash
pkill -f "node dist/server.js"; sleep 8
curl -s -o /dev/null -w "after kill: %{http_code}\n" http://127.0.0.1:8123/
```

Expected: 200 both times. Report the actual output. If it does not come back, the unit is wrong and that is a finding, not something to work around.

Leave the service **running** — it is now the supervised dashboard.

- [ ] **Step 5: Commit**

```bash
git add scripts/com.local.mtplx-dashboard.plist scripts/install-launchd.sh README.md
git commit -m "feat: launchd supervision for the dashboard, plus the gbrain repoint runbook"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Background you need:** `CLAUDE.md` currently describes a Phase 1 world in which `log.html`/`detail.html` have no data source and `upstreamOk` is always null. All of that is now wrong.

- [ ] **Step 1: Rewrite the affected sections**

- "What this is": the four pages again have four purposes; the log and detail pages are live.
- Architecture: add `capture.ts`, `engineJoin.ts`, `proxy.ts`; note that the proxy is raw `node:http` deliberately (D1).
- Data model: `request` and `transcript` are now populated; `REQUEST_SERIES` now returns real data, so `history.html`'s run aggregates and the dashboard's range selector work.
- Connection/offline handling: `upstreamOk` is real and independent of `scrapeOk`; `null` means "nothing proxied yet".

- [ ] **Step 2: Add these conventions to "Conventions to preserve"**

```markdown
- The forward path has NO timeout, deliberately. gbrain does not time out local
  inference (its own test/ai/local-fetch-no-timeout.test.ts) and a cold-cache
  35B MoE can run for minutes. `config.scrapeTimeoutMs` is 2500ms and belongs
  to the scrape path alone — never reuse it for forwarding.
- Capture is a TEE, never buffer-then-forward: the same handler that writes a
  chunk to the client accumulates it. Buffering would add latency proportional
  to response size, in the one path this dashboard exists to measure.
- The proxy never synthesizes a response and never retries. Upstream status,
  headers and body pass through verbatim, errors included. The single exception
  is a connection-level failure, where there is no upstream response to relay.
- Engine-measured TTFT and decode rate are attributed to a request ONLY when
  exactly one request completed in the interval (`Δcount == 1`). Over any wider
  interval Δsum/Δcount is a mean; `engine_joined` records which you are looking
  at. Never interpolate.
- `getRequest()` LEFT JOINs `transcript`, never INNER. Transcripts age out at
  TRANSCRIPT_RETENTION_DAYS (7) while requests keep RETENTION_DAYS (30), so an
  absent transcript is the normal case for most of a request's life, not a
  missing request.
- log.html and detail.html read SQLite, not an in-memory ring. The log
  therefore survives a restart and detail permalinks keep working — do not
  reintroduce a server-side log buffer.
```

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
grep -rn "no per-request identity\|Unavailable in this phase\|always .null. in this phase" CLAUDE.md README.md public/ || echo "no stale Phase 1 claims"
git add CLAUDE.md README.md
git commit -m "docs: describe the capture proxy architecture"
```

---

## Done when

- `npm test` passes: `capture` (18), `engineJoin` (11), `proxy` (10), plus the existing 108 and the 9 new `db` tests and 2 new scraper tests — 158 total.
- `npm run typecheck` and `npm run build` are clean.
- A completion sent to `:8010` returns normally and produces a `request` row with real token counts, plus a `transcript` row.
- A single-request interval yields `engine_joined = 1` with a non-null `ttft_s`; a burst yields `engine_joined = 0` with nulls.
- `/v1/models` through the proxy passes through and creates no row.
- An unreachable upstream returns 502 without retrying.
- A 3.2s upstream is not cut off — no forward timeout exists.
- `log.html` lists requests and survives a dashboard restart; `detail.html` renders a transcript and distinguishes its three empty states.
- The launchd unit restarts the dashboard after `pkill`.
- Every page loads with no console errors.

## Not in this plan

- **Repointing gbrain.** The runbook ships in Task 9; running it moves production traffic onto the proxy and is the user's call, made after the proxy is verified.
- **The gemma target on :8087**, the target selector, and `history.html`'s second axis — Phase 3.
- **Streaming capture.** Streamed requests get a row but no transcript and no engine join (D3). Capturing them means SSE chunk reassembly with a first-chunk timestamp, which would also yield real proxy-side TTFT and retire the `Δcount == 1` join — the natural Phase 3+ follow-on.
- **TTFT p50/p90 from histogram buckets**, still deferred from Phase 1. The bucket deltas are persisted, so it remains additive.
