# Adapting the dashboard to rapid-mlx Prometheus metrics

Date: 2026-09-05
Status: approved design, pending implementation plan
Branch: `rapid-mlx-prometheus`

## 1. Context

MTPLX no longer runs on this machine. `~/.rapid-mlx/rapid-serve.sh` documents a
2026-09-01 swap to rapid-mlx on `:8000`, followed by a 2026-09-04 dense-to-MoE
weight swap (`unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit`). A second rapid-mlx instance
serves gemma-4 on `:8087` for gbrain's dream phases. Both run rapid-mlx 0.13.4.

The dashboard is therefore pointed at a server whose `/metrics` it cannot parse:
MTPLX returned JSON (`{latest, recent[], tool_parse_counters}`), rapid-mlx returns
Prometheus text exposition.

This is not a format change. It is a change of data model, and it invalidates
roughly half the product.

## 2. What rapid-mlx actually exposes

Verified against both live servers on 2026-09-05, including a probe request to
observe which series move.

### 2.1 Prometheus endpoint

- The family set is **not fixed**, and varies along two independent axes:
  - *Traffic state*: 59 families on a freshly restarted qwen server, 73 after a
    single completion. The `prefix_cache_*` families and the `_max`/`_last`
    gauges do not exist until a request has completed.
  - *Backend*: gemma `:8087` exposes 80 families — 10 that qwen does not have at
    all, an entire `prefix_cache_radix_*` subsystem (hits/misses/nodes/max_depth/
    lookup p50+p99/deduped bytes).

  Consequence: the gauge series list must be **discovered from the scrape**, not
  hardcoded. This is safe because gauge names are stored as a column value and
  bound as parameters. It must not be modelled on `REQUEST_SERIES`, whose closed
  `Object.hasOwn` allowlist exists specifically because those names are
  interpolated into SQL.
- Non-standard suffixes on histograms: `_max` and `_last` (e.g.
  `rapid_mlx_model_decode_tokens_per_second_last`). `_last` exists for decode
  tok/s but **not** for TTFT.
- Labels carry real dimensions: `family`/`method` on spec-decode, `model` (full
  filesystem snapshot path) on the per-model families, `reason` on fallthrough
  counters, `dtype`/`mode`/`status` on config gauges.

### 2.2 No per-request identity, anywhere

This is the load-bearing finding. `/v1/status` exposes a `requests` array that
**stays empty even while `num_running: 1`** (verified by polling at 3 Hz through a
live completion). There is no request id, no prompt preview, no transcript, and
no completed-request history on any endpoint.

Consequently `log.html`, `detail.html`, the `request` table, the transcript
capture patch and `mtplx:postupgrade` all lose their data source outright.

### 2.3 Speculative decoding is inactive

`spec_decode_attempts_total`, `spec_decode_accept_ratio` and
`suffix_decode_draft_width` read 0 on **both** backends, and `/v1/models` reports
`speculative_decoding: null`. The MoE weights carry no MTP head. The dashboard's
hero card has no data to show and porting it changes nothing.

### 2.4 Client traffic

From the rapid-mlx access logs:

- `POST /v1/chat/completions` is the only generation endpoint in use:
  2,586 calls on qwen, 2,454 on gemma. Near-parity — the gemma tier is co-equal,
  not a side experiment.
- No traffic to `/v1/messages`, `/v1/completions` or `/v1/embeddings`
  (embeddings go to Voyage).
- Nothing in gbrain's `src/` sets `stream: true`; known clients are
  non-streaming.
- gbrain addresses backends by distinct base URL per provider in
  `~/.gbrain/config.json` (`provider_base_urls.lmstudio`/`.openai` -> `:8000`,
  `.mlx-gemma4` -> `:8087`). Repointing is three config strings, not a code change.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Recover per-request data with a **capture proxy**, not by dropping the log/detail pages | rapid-mlx exposes no request identity; a proxy in the request path is the only source |
| D2 | Proxy listens on **new ports**, gbrain repointed | rapid-mlx and its launchd setup stay untouched; backing out is a config revert |
| D3 | **Both backends**, multi-target throughout | gemma carries ~49% of completions; a single-target dashboard is blind to half the fleet |
| D4 | Transcripts persisted in a **separate table with independent retention** | keeps `request` narrow for aggregate queries; ~0.6-2 GB/month at 30d is not worth paying for metrics history |
| D5 | Hero card becomes **throughput + memory + queue depth** | spec-decode reads zero; lead with what is live and actionable |

## 4. Architecture

### 4.1 The hybrid, and why it is required

A non-streaming proxy **cannot measure TTFT**. It observes only the completed
response, so it can derive wall-clock elapsed, `prompt_tokens`/`completion_tokens`
from `usage`, and a blended tok/s — but not time-to-first-token, and not decode
rate cleanly separated from prefill.

The Prometheus scrape has precisely what the proxy lacks, and vice versa:

| Source | Provides |
|---|---|
| Proxy | request id, prompts, responses, tool calls, model, outcome, status, wall-clock elapsed, token counts |
| Scrape | engine-measured TTFT (histogram), decode tok/s, prefix cache, Metal memory, queue depth, spec-decode, config gauges |

Both feed one `StatePayload` per target. Neither alone is sufficient for truthful
hero stats.

### 4.2 The join, and its limit

When the proxy completes request R, the next scrape's `Δttft_sum / Δttft_count`
is R's engine-measured TTFT — exactly, **but only when `Δttft_count == 1`**.

Under concurrency that delta is a mean across several requests. Rule: attribute
engine metrics to a request only when `Δcount == 1`; otherwise persist `null` and
set `engine_joined = 0`. Renderers already degrade to an em-dash on null.
Interpolating here would fabricate per-request numbers, which is strictly worse
than showing nothing.

### 4.3 Modules

One `Target` object per backend, owning its own proxy listener, scraper, health
poller, rings and log buffer. Multi-target is then an array rather than a
`targetId` parameter threaded through every existing function.

- `targets.ts` — parses the target list from config: `{id, label, upstreamUrl, proxyPort}`
- `proxy.ts` — per-target reverse proxy. `/v1/chat/completions` non-streaming is
  buffered and captured. Everything else — including streaming — is opaque
  pass-through.
- `promParse.ts` — pure Prometheus text -> `{name, labels, value}[]`. No I/O.
- `promScraper.ts` — replaces `metricsPoller`'s fetch/parse half. Owns counter
  reset detection and delta-based rates.
- `metricsPoller.ts` is **deleted**. Its ring buffers, log buffer and `sig()`
  change detection move onto the per-target aggregator; its polling half is
  split between `promScraper.ts` (engine metrics) and `proxy.ts` (request events).
- `healthPoller.ts` — repurposed; run detection per 4.4.
- `sse.ts`, `server.ts` — mechanism unchanged; `StatePayload` gains a target dimension.

### 4.4 Run detection

rapid-mlx `/health` has no `startup.pid`/`started_at`. Replacement: a **decrease
in `rapid_mlx_uptime_seconds` between scrapes is a restart**, and
`rapid_mlx_build_info{version,model}` supplies the config snapshot.

`started_at = scrapeTime - uptime_seconds * 1000` must be computed **once, at
restart detection**, and held stable until the next detection. Recomputing per
scrape would let float-second precision and scrape jitter wander the derived
origin by a few ms, minting a new `run` row every second against the unique index.

This is the same reset test the counter differ needs — one mechanism, two consumers.

### 4.5 Concrete targets

| id | label | upstream | proxy port | gbrain key repointed |
|---|---|---|---|---|
| `qwen` | Qwen3.6-35B-A3B (chat/tools) | `http://127.0.0.1:8000` | `8010` | `provider_base_urls.lmstudio`, `.openai`, `llm_base_url` |
| `gemma` | gemma-4-26B (dream phases) | `http://127.0.0.1:8087` | `8011` | `provider_base_urls.mlx-gemma4` |

The dashboard's own HTTP port (`PORT`, default `8123`) is unchanged and serves
the pages and SSE; the proxy listeners are separate sockets so a page-serving
fault and an inference fault cannot share a failure domain.

## 5. Data model

Schema version 1 -> 2. **No migration**: on version mismatch, rename
`data/history.db` -> `data/history-v1-mtplx.db` and start clean. MTPLX and
rapid-mlx rows are not comparable on any axis that matters, so a migration would
produce history that silently lies across the boundary. Old data stays readable.

All three tables gain `target_id TEXT NOT NULL` (`qwen`, `gemma`), indexed with `ts`.

### 5.1 `run`

- Unique index `(pid, started_at)` -> **`(target_id, started_at)`**.
- Dropped (no rapid-mlx equivalent): `pid`, `runtime_mode`, `generation_mode`,
  `depth`, `verify_core`, `paged_kv_quantization`.
- Added: `version` (from `build_info`), `kv_cache_dtype`, `turboquant_mode`,
  `spec_decode_method`, `engine_type`.
- `health` TEXT retained, now holding `/health` + `/v1/status` + `build_info`.

The config diff on `history.html` stays scoped to this promoted column set, per
the existing convention — same reasoning, new columns.

### 5.2 `request`

Dropped (entire MTP block): `drafted_by_depth`, `accepted_by_depth`,
`accept_rate`, `mtp_depth`, `bonus_tokens`, `correction_tokens`, `verify_calls`,
`draft_time_s`, `verify_forward_time_s`, `verify_eval_time_s`, `accept_time_s`,
`cache_source`, `session_cache_hit`, `cached_tokens`, `cache_restore_time_s`,
`ssd_cache_hit`, `ssd_cached_tokens`.

Retained: `request_id`, `run_id`, `ts`, `model`, `prompt_tokens`,
`completion_tokens`, `ttft_s`, `request_elapsed_s`, `decode_tok_s`,
`client_label`, `tool_call_count`, `user_preview`.

Provenance changes for two of these: `client_label` is derived from the request's
`User-Agent` (MTPLX supplied it directly), and `user_preview` is the truncated
last user message read off the proxied request body.

Added (proxy-observed): `outcome` (succeeded|cancelled|failed), `status_code`,
`streamed`, `finish_reason`, `engine_joined`.

### 5.3 `transcript` (new)

`request_id` PK referencing `request`, `messages` (JSON), `response_text`,
`tools`, `truncated`. Pruned on `TRANSCRIPT_RETENTION_DAYS` (default 7),
independent of `RETENTION_DAYS` (default 30). Bodies capped at 256 KB with
`truncated` set.

### 5.4 Sparkline series split

`REQUEST_SERIES` currently derives all four sparklines from `request`. Only two
can remain request-derived:

| Spark | Today | Under rapid-mlx |
|---|---|---|
| decode | request | request (proxy + engine join) |
| ttft | request | request (engine join) |
| prefill | request | **gauge** — no per-request prefill; `/v1/status.prompt_tps` is instantaneous |
| accept | request | **gauge** — `spec_decode_accept_ratio` is server-wide, labeled by family/method |

`activeRings()` and `renderSparks()` now read two sources. The existing rule that
`renderSparks()` is the sole call site of `sparks.*.render()` becomes more
load-bearing, not less, and must be restated in `CLAUDE.md`.

## 6. Metric mapping and UI

| Card | Fate | Source |
|---|---|---|
| Speculative decoding | no live data | `spec_decode_*` / `suffix_decode_*` parse fine, read zero |
| Decode throughput | improves | proxy + `decode_tokens_per_second_last`/`_max` |
| Time to first token | improves | histogram buckets give real p50/p90 |
| KV cache | improves | `prefix_cache_*` + `kv_checkpoint_*` |
| Tool-call parsing | changes source | proxy counts real `tool_calls`; plus `response_format_strict_*` |
| Context window | degrades | prompt-token distribution vs `/v1/models` `context_window` (262144) |
| Prefill throughput | degrades | `/v1/status.prompt_tps` only |
| Verify-time breakdown | **dies** | no equivalent |

New cards: Metal memory (active/peak/cache bytes), queue depth
(`requests_running`/`requests_waiting`), request outcomes (succeeded/cancelled/
failed, `cancelled_via_disconnect`), repetition-loop stops/breaks.

Hero (D5): decode tok/s with p50/p90, Metal active/peak, queue depth.
Spec-decode becomes a normal card that self-hides while `attempts_total == 0`, so
it lights up automatically if an MTP model is ever loaded again.

### 6.1 Multi-target in the UI

`index.html` and `log.html` gain a target selector in the header; the selected
target is held in the URL (`?target=qwen`) so a permalink is stable and
`detail.html` can resolve a request without a separate lookup. `StatePayload`
carries all targets on every snapshot/tick — consistent with the existing
convention of sending the payload whole rather than diffing — and the client
renders the selected one.

`history.html` gains the target as a second axis on run comparison, which is the
single largest UI change in this design and the most reasonable thing to defer to
a later phase if the plan needs splitting.

## 7. Failure posture

- **No proxy timeout on the forward path.** gbrain's
  `test/ai/local-fetch-no-timeout.test.ts` shows local inference calls are
  deliberately untimed; a cold-cache 35B MoE can legitimately run for minutes.
  `MTPLX_TIMEOUT_MS: 2500` is correct for scraping and dangerous on the forward
  path. Two separate budgets.
- Forward first, capture second. All capture/persist wrapped so failure degrades
  to a missing log entry, never a failed completion.
- Upstream errors pass through verbatim (status, headers, body). Never
  synthesize, never retry — a retried non-idempotent completion double-bills
  compute and corrupts counters.
- Streaming pipes straight through, uncaptured. Buffering would delay first
  token, the exact metric this dashboard protects.
- Connection state is two-dimensional per target: `scrapeOk` and `upstreamOk` are
  independent. The `body.disconnected` banner must say which is down, or a
  healthy inference path reads as offline.

## 8. Testing

The dashboard now sits in gbrain's request path, so tests stop being optional.

- `promParse.ts` — unit tests against a golden fixture captured from the live
  server, including families that only appear after first traffic.
- Counter-reset detection and delta rates — unit tests including the
  uptime-goes-backwards restart case.
- The `Δcount == 1` join — unit tests proving `null` under concurrency rather
  than a fabricated value.
- `proxy.ts` — integration tests against a stub upstream: pass-through fidelity,
  verbatim error propagation, no injected timeout, capture-failure isolation
  (upstream succeeds even when the store throws).

## 9. Retirement and config

Deleted, subject no longer exists: `patches/` (transcript capture patch +
README), `scripts/mtplx-postupgrade.sh`, the `mtplx:postupgrade` npm script, and
the MTPLX sections of `CLAUDE.md` / `README.md`. The uncommitted patch edits
currently on this branch are reverted.

`MTPLX_URL` / `MTPLX_TIMEOUT_MS` become per-target config. Scrape timeout and
forward timeout are separate settings; the forward timeout has no default.

## 10. Suggested phasing

This design touches every server module and all four pages. It is coherent as one
spec but large for one plan; the natural seams, each independently shippable:

1. **Scrape path** — `promParse.ts`, `promScraper.ts`, schema v2, run detection
   via uptime. Dashboard works single-target, read-only, no proxy. Proves the
   parser and the reset logic against real data.
2. **Proxy capture** — `proxy.ts`, `transcript` table, the `Δcount == 1` join,
   log/detail pages restored. Repoint gbrain's qwen keys only.
3. **Multi-target** — second target, `target_id` throughout, selector UI,
   `history.html`'s second axis. Repoint gemma.

Phase 1 leaves the dashboard useful and phase 2 is where gbrain first depends on
this process — worth landing separately so the availability change is its own
reviewable step.

## 11. Out of scope

- Renaming the repo. `mtplx-dashboard` is now a misnomer, but renaming breaks
  paths and launchd references — a separate decision.
- The external poller hitting `/v1/mtplx/flight` for 404s. Not this repo and not
  gbrain; worth hunting down separately.
- Streaming capture. Deliberately deferred: no known client streams, and
  capturing it correctly means SSE chunk reassembly with a first-chunk timestamp.
  If a streaming client appears, that is the natural way to obtain real
  proxy-side TTFT and retire the `Δcount == 1` join.
