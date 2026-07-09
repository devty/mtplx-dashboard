# MTPLX Dashboard

A beautiful, **zero-dependency** realtime dashboard and live activity log for a local
[MTPLX](https://mtplx.com) inference server. Two self-contained HTML files, no build
step, no npm, no CDNs — just point a static file server at the folder and open it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **What it's for:** MTPLX runs LLMs on Apple Silicon using **MTP (multi-token-prediction)
> speculative decoding**. Its server exposes a rich `/metrics` endpoint — this project turns
> that into (1) a dashboard that tells the *speculative-decoding* story at a glance, and
> (2) a "tail -f for the model" live log of what's being generated right now.

---

## Two pages

### `index.html` — Metrics dashboard
The hero is **speculative decoding**: tokens committed per verify pass (an autoregressive
decoder yields 1.0), accepted-vs-drafted per depth, and acceptance probability — the numbers
that explain *why* MTP is fast. Around it:

- **Decode & prefill throughput** (tok/s) with live sparklines
- **Time to first token**
- **Context window** usage with a cached-vs-fresh-prefill split
- **Verify-time breakdown** — where decode time actually goes
- **KV cache** (RAM/SSD source + hit) and **tool-call parse health**

### `log.html` — Live activity log
One row per completed request, newest first:

- **Headline:** the prompt (server-truncated preview)
- **Chips:** tokens in→out · decode tok/s · TTFT · elapsed · conversation depth ·
  tool-calls made · acceptance % · reasoning/thinking flag · client · short request id · live "Ns ago"
- **Click any row** to expand a full detail drawer: every timing/token field, per-depth
  acceptance bars, the conversation role sequence, and available tools.

The two pages cross-link via a header nav.

---

## Quick start

You need a running MTPLX server with its OpenAI-compatible endpoint (and `/metrics`) on
`http://127.0.0.1:8000` — the default.

```bash
git clone https://github.com/devty/mtplx-dashboard.git
cd mtplx-dashboard
python3 -m http.server 8123
# then open:
#   http://127.0.0.1:8123/          → dashboard
#   http://127.0.0.1:8123/log.html  → live log
```

Serve it over **http** (not `file://`) so the browser sends an `Origin` header — the MTPLX
server reflects it in its CORS response, which is exactly why no proxy is needed.

### Pointing at a different host/port
Each file has a single endpoint constant near the top of its `<script>`:

```js
const API = 'http://127.0.0.1:8000';
```

Change it in both `index.html` and `log.html` to target a remote or differently-ported server
(the server must allow the dashboard's origin via CORS).

---

## How it works

- Polls `GET {API}/metrics` once per second. The response is
  `{ latest, recent[32], tool_parse_counters }` — `latest` is the most recent request,
  `recent` is a rolling 32-deep history of completed requests, each a full per-request record.
- Sparklines are hand-drawn inline SVG; the client keeps its own ring buffer (the dashboard
  seeds it from `recent` on load) so history is immediate and honest per-request, not a flat
  1 Hz line.
- The live log dedups by `request_id`, stamps an arrival time on first sight (the records carry
  no wall-clock), and keeps a 300-row rolling buffer.
- Both pages are light/dark aware (`prefers-color-scheme`) and degrade gracefully when the
  server is unreachable (dim + reconnect banner, last values retained).

## Limitations (by design — it reads `/metrics`, nothing more)

- **Completed requests only.** A long generation appears when it *finishes*, not mid-flight.
- **Prompt is a server-truncated preview**, and there is **no assistant response body** in
  `/metrics` — this is a live pulse, not a full trace store.
- **Caller attribution is approximate.** OpenAI-compatible clients report the same
  `client_label`, so multiple apps hitting one server aren't cleanly distinguished.
- For full prompt/response bodies and tool-call arguments, you'd put a logging proxy in front
  of the server — out of scope here.

---

## License

[MIT](./LICENSE) © 2026 Tyler Singletary

Not affiliated with or endorsed by MTPLX — a community tool built against its public
`/metrics` endpoint.
