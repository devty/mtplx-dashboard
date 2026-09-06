# rapid-mlx Dashboard

A realtime dashboard, run-comparison view, and nightly-dream health view for a local rapid-mlx
inference server on Apple Silicon. A small Node/TypeScript server scrapes rapid-mlx's Prometheus
`/metrics` endpoint itself and pushes updates to the browser over Server-Sent Events — all five
pages (`public/index.html`, `public/log.html`, `public/detail.html`, `public/history.html`,
`public/dream.html`) stay plain HTML/CSS/JS, no client framework, no build step for the frontend.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **What it's for:** rapid-mlx runs LLMs on Apple Silicon and exposes a standard Prometheus
> text-exposition `/metrics` endpoint — decode/prefill throughput, TTFT histograms, prefix-cache
> and Metal-memory gauges, queue depth, and speculative-decoding counters. This project turns that
> into a live dashboard, plus SQLite-backed history so a fresh browser tab or a restart doesn't
> lose depth.
>
> **What it is not, yet:** rapid-mlx exposes no per-request identity anywhere — no request id, no
> prompt preview, no transcript, not even for in-flight work (`/v1/status.requests` stays empty
> while a request is running). The live per-request log and its detail page are placeholders in
> this phase; they return once a capture proxy sits in the request path (Phase 2 of the design doc
> under `docs/superpowers/specs/`).

### Dashboard
A grid of cards over the live scrape: decode and prefill throughput sparklines, a TTFT interval
mean, context-window occupancy, prefix-cache hit rate and size, structured-output health, queue
depth, cumulative request outcomes, Metal memory detail, KV-checkpoint I/O, and a self-hiding
speculative-decoding card that appears once MTP attempts are non-zero. A live/1h/24h/7d range
selector switches the sparklines between the in-memory ring and bucketed SQLite history.
(No current screenshot — the previous one showed the MTPLX-era speculative-decoding hero, which
this branch removed; a fresh capture is still needed.)

---

## Pages

### `public/index.html` — Metrics dashboard
The hero is **throughput, memory and queue depth** — decode tok/s (p50/p90), Metal active/peak
bytes, and requests running/waiting — the numbers that are actually live once speculative decoding
reads zero on this deployment. Around it:

- **Decode & prefill throughput** (tok/s) with live sparklines
- **Time to first token** — real p50/p90 from the engine's own histogram buckets
- **Context window** usage (prompt-token distribution vs. `/v1/models`' `context_window`)
- **Prefix cache** (hits/misses/nodes/lookup latency) and **Metal memory** detail
- **Queue depth** and **request outcomes** (succeeded/cancelled/failed)
- **Structured-output / tool-call parse health**
- **Speculative decoding** as a normal card that self-hides while `spec_decode_attempts_total` is
  zero (true on both backends today — the MoE weights currently loaded carry no MTP head) so it
  lights back up automatically if an MTP model is ever loaded again.

A **live / 1h / 24h / 7d** range selector redraws the sparklines from bucketed SQLite history
instead of the live in-memory rings.

### `public/log.html` — Live activity log (unavailable this phase)
Shows a single explanatory panel rather than an empty feed — an empty live log is otherwise
indistinguishable from an idle server. Returns with the Phase 2 capture proxy.

### `public/detail.html` — Single-request detail (unavailable this phase)
Was a permalink target for a log row (`detail.html?id=<request_id>`); there is no row to link from
now, so it shows the same explanatory panel. Returns with Phase 2.

### `public/history.html` — Run history & comparison
Every detected rapid-mlx run (a restart, detected from either `rapid_mlx_uptime_seconds` decreasing
between scrapes, or the derived run origin landing more than 30s after the last successful
observation — which catches a restart that happened entirely during a scrape outage, where the
uptime-decrease check alone would see nothing), newest first, with per-run request counts and
decode/TTFT aggregates — these
read as zero/`—` until the Phase 2 capture proxy is recording requests. Check two rows to see a
config diff, scoped to the columns actually promoted onto a `run` row (model, version, KV-cache
dtype, turboquant mode, spec-decode method, engine type, context window), not a deep diff of the
full `/health`+`/v1/status`+`build_info` blob, which carries dozens of internal flags that would
bury a real change in noise. Below the table, one gauge chart per series **discovered from the
scrape** (the family set is not fixed — 59 families on a cold server, 73 after first traffic, 80 on
a second backend — so this list is never hardcoded) shows dashed markers at each run's start.
Unlike `index.html`, this page has no SSE connection — it fetches on load and offers a manual
**Refresh** button, since historical/forensic browsing has no need for sub-minute freshness.

The pages cross-link via a header nav.

---

## Quick start

You need a running rapid-mlx server with its Prometheus `/metrics` endpoint reachable — the
default target this server scrapes is `http://127.0.0.1:8000`. Node `>=22.5` is required (see
`engines` in `package.json`) because the SQLite persistence layer (below) uses the built-in
`node:sqlite` module rather than a third-party driver — no extra dependency needed, but the
version floor is firm.

```bash
git clone https://github.com/devty/mtplx-dashboard.git
cd mtplx-dashboard
npm install
npm run dev
# then open:
#   http://127.0.0.1:8123/              → dashboard
#   http://127.0.0.1:8123/history.html  → run history & comparison
#   http://127.0.0.1:8123/dream.html    → gbrain nightly-dream health
```

`npm run dev` runs the TypeScript server directly (via `tsx watch`, auto-restarting on change) —
no separate compile step needed for day-to-day development. For production, build once and run
the compiled output:

```bash
npm run build
npm start
```

`npm test` runs `node:test` unit tests covering the Prometheus parser (`promParse.ts`, against
golden fixtures captured from live servers, including families that only appear after first
traffic), series-name derivation and counter-delta/restart logic (`promSeries.ts`), run detection
(`runTracker.ts`), target-list parsing (`targets.ts`), the scrape loop's per-interval derivations
(`promScraper.ts`), the SQLite persistence layer (`db.ts`), and the nightly-dream pipeline
(`dreamParse.ts`, `dreamAttribute.ts`, `dreamSchedule.ts`, `dreamIngest.ts`, `dreamService.ts` —
log parsing, source attribution, missed-night derivation, ingest and caching, against verbatim log
excerpts in `server/fixtures/dream/`) — the storage tests against a throwaway on-disk file in a
temp directory, not `:memory:`, because an in-memory database is private to the connection that
opened it and the tests assert through a second read connection. There is no frontend test
harness; verify page changes by loading them against a real rapid-mlx instance.

### Configuration

The server scrapes one configured rapid-mlx target — set these as environment variables
(`.env.example` documents the same list; this project has no `dotenv` dependency, so either
`export` them in your shell, pass them inline, or use Node's native `--env-file=.env` flag):

| Variable                     | Default                              | Meaning                                            |
|-------------------------------|---------------------------------------|-----------------------------------------------------|
| `RAPID_MLX_TARGETS`          | `qwen=http://127.0.0.1:8000:8010`     | Comma-separated `id=<upstreamUrl>[:<proxyPort>][\|label]` list. One entry in this phase; the `:<proxyPort>` suffix is parsed now but unused until the Phase 2 capture proxy. |
| `PORT`                       | `8123`                                | Port this dashboard server listens on               |
| `POLL_INTERVAL_MS`           | `1000`                                | How often to scrape `/metrics`                      |
| `SCRAPE_TIMEOUT_MS`          | `2500`                                | Timeout per scrape request (separate from any future forward-path timeout — see the design doc) |
| `RING_SIZE`                  | `120`                                 | Sparkline history depth (dashboard, live view)      |
| `LOG_BUFFER_SIZE`            | `300`                                 | Reserved for the Phase 2 live-log buffer; unused while `log.html` has no data source |
| `MAX_BACKOFF_MS`             | `10000`                               | Ceiling for scrape-retry backoff when rapid-mlx is unreachable |
| `DB_PATH`                    | `data/history.db`                     | SQLite history file. Relative paths resolve against the repo root. |
| `PERSIST_ENABLED`            | `1`                                   | `0` disables all persistence; the dashboard runs live-only. |
| `RETENTION_DAYS`             | `30`                                  | Rows older than this are pruned.                     |
| `TRANSCRIPT_RETENTION_DAYS`  | `7`                                   | Reserved for Phase 2 transcript rows; the `transcript` table exists now but nothing writes to it yet. |
| `PRUNE_INTERVAL_MS`          | `3600000`                             | How often the prune runs.                            |
| `HEALTH_INTERVAL_MS`         | `5000`                                | `/health`+`/v1/status`+`/v1/models` poll cadence.    |
| `GAUGE_PERSIST_INTERVAL_MS`  | `10000`                               | Gauge persistence interval — much slower than the scrape itself; unchanged series are also skipped, since ~74 series at 1 Hz would be ~6.4M rows/day. |
| `GBRAIN_LOG_PATH`            | `~/.gbrain/dream-nightly.log`         | Nightly-dream log the Dream page parses (read-only).  |
| `GBRAIN_BRAIN_DIR`           | `~/mybrain`                           | Brain repo for the read-only `git log` commit cross-check. Unreadable yields "couldn't check", which the page keeps distinct from "no commit". |
| `GBRAIN_DREAM_PLIST`         | `~/Library/LaunchAgents/com.gbrain.dream-nightly.plist` | LaunchAgent the dream schedule is read from. Without it, missed-night detection disables itself rather than assuming an hour. |

```bash
RAPID_MLX_TARGETS='qwen=http://box.local:8000:8010' npm run dev
```

### Project layout

```
mtplx-dashboard/
├── server/              TypeScript server — scrapes rapid-mlx, pushes SSE
│   ├── server.ts          Express app: serves public/, /api/events (SSE), /api/metrics,
│   │                        /api/history/series, /api/history/gauges, /api/history/gauge-names,
│   │                        /api/history/runs, /api/history/runs/:id
│   ├── targets.ts         RAPID_MLX_TARGETS parsing
│   ├── promParse.ts       Pure Prometheus text-exposition parser (no I/O)
│   ├── promSeries.ts      Series-name derivation, counter-delta state, restart detection
│   ├── promScraper.ts     Scrape loop, retry/backoff, ring buffers, change detection, gauge
│   │                        persistence — replaces the old MTPLX-era metricsPoller.ts
│   ├── runTracker.ts      Run identity from rapid_mlx_uptime_seconds
│   ├── healthPoller.ts    Low-frequency /health + /v1/status + /v1/models cache
│   ├── db.ts              SQLite persistence: schema v2, writes/queries via node:sqlite,
│   │                        bucketed range queries, pruning
│   ├── db.test.ts, promParse.test.ts, promSeries.test.ts, runTracker.test.ts,
│   │   targets.test.ts, promScraper.test.ts, dream*.test.ts   node:test unit tests (npm test)
│   ├── dreamParse.ts      Pure parser for gbrain's nightly-dream log
│   ├── dreamAttribute.ts  Which cycle block belongs to which source (and the global pass)
│   ├── dreamSchedule.ts   Expected nights from the LaunchAgent plist; missed-night detection
│   ├── dreamIngest.ts     The only dream module doing I/O: log + git cross-check + store writes
│   ├── dreamService.ts    Dream config resolution and the 30s ingest cache
│   ├── fixtures/          Golden Prometheus scrapes captured from live servers, plus
│   │                      dream/ — verbatim nightly-dream log excerpts
│   ├── sse.ts             SSE client registry, broadcast, heartbeat
│   ├── config.ts          Env var → config
│   └── types.ts           Shared RingBuffers / StatePayload shapes
├── public/              Static frontend — plain HTML/CSS/JS, no build step
│   ├── index.html         Metrics dashboard (with live/1h/24h/7d history range selector)
│   ├── log.html           Explains why the live log is unavailable this phase
│   ├── detail.html        Same, for the old per-request permalink target
│   ├── history.html       Run history: run table, config diff, discovered gauge charts
│   └── dream.html         gbrain nightly-dream health: night strip, per-source phase marks
├── data/                SQLite history file lives here by default (DB_PATH, gitignored)
├── docs/                Design docs under docs/superpowers/specs/ (no current README screenshot —
│                        the MTPLX-era one was removed; see the Dashboard section above)
├── package.json         Scripts: dev / build / start / test / typecheck
├── tsconfig.json
└── .env.example         Documents the env vars above (not auto-loaded)
```

`npm run dev`/`npm start` compile nothing on their own from `public/` — those files are served
as-is by `express.static`. Only `server/**/*.ts` goes through TypeScript.

---

## How it works

- A Node/TypeScript server (`server/`) scrapes `GET {upstreamUrl}/metrics` on an interval,
  server-side — not the browser. The response is standard Prometheus text exposition: families,
  types, labels, and values, with no request identity anywhere.
- The server keeps its own in-memory sparkline history (ring buffers sized `RING_SIZE`) and
  retries with exponential backoff (capped at `MAX_BACKOFF_MS`) when rapid-mlx is unreachable.
  Unlike the old MTPLX-era poller, these rings start **empty** on every restart — a Prometheus
  scrape has no rolling-window equivalent to seed from, so depth rebuilds live.
- Browsers connect once via `EventSource` to `/api/events`: an initial `snapshot` event delivers
  full state immediately, and a `tick` event pushes out on every genuine change thereafter — no
  client-side polling.
- Sparklines are hand-drawn inline SVG on the client; only *where the history comes from* is
  server-side now, not a per-tab ring buffer.
- Because scraping happens server-to-server, the browser only ever talks same-origin to this Node
  server.
- `index.html` is light/dark aware (`prefers-color-scheme`) and degrades gracefully when rapid-mlx
  is unreachable (dim + reconnect banner, last values retained) or when the SSE connection itself
  drops (native `EventSource` auto-reconnect, no custom retry logic needed). `history.html` is
  light/dark aware but holds no SSE connection at all — it's a fetch-on-load, manual-refresh page.
  `log.html`/`detail.html` hold no SSE connection either, in this phase, because there is nothing
  for them to subscribe to.

## Limitations (by design — it reads `/metrics`, nothing more, in this phase)

- **No per-request history, yet.** rapid-mlx exposes no request id, no prompt preview, and no
  transcript — not even for in-flight work. The live log and single-request detail pages are
  explanatory placeholders until a capture proxy exists in the request path (Phase 2).
- **Speculative decoding reads zero.** The MoE weights currently loaded carry no MTP head, so the
  spec-decode card self-hides; it lights back up automatically if that changes.
- **Prefill throughput is server-wide, not per-request.** `/v1/status.prompt_tps` is the only
  signal rapid-mlx exposes for it.
- **Multi-target is one target for now.** `RAPID_MLX_TARGETS` and the `target_id` columns already
  support more than one backend; the selector UI and a second live target arrive in Phase 3.

---

## License

[MIT](./LICENSE) © 2026 Tyler Singletary

Not affiliated with or endorsed by rapid-mlx — a community tool built against its public
Prometheus `/metrics` endpoint.
