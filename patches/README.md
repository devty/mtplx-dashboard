# MTPLX patches

Local patches for the upstream inference server ([`youssofal/MTPLX`](https://github.com/youssofal/MTPLX)).
These are **not** submitted upstream — they're a fork-and-patch you apply to your own MTPLX
checkout so this dashboard can show data the stock server doesn't expose.

## `mtplx-full-transcript-capture.patch`

**What it does.** Stock MTPLX `/metrics` only carries a 180-char preview of the *last* user
message and **no assistant response body** (the generated text is used to build the HTTP reply
and then discarded — only a 120-char preview reaches stdout logs). This patch adds two optional
fields to each completed-request record so the dashboard's per-request detail page can render the
**full prompt** and the **full response**:

- `request_messages_full` — `[{ role, content }, …]`, the complete prompt transcript. Added in
  `_request_observability(...)`, which is merged into every completion envelope, so one edit
  covers the streaming, AR-batch, and smart-fan paths.
- `response_text` — the finished assistant text, stamped onto the latest record via a small
  `_dashboard_capture_response_text(...)` helper at the two completion sites.

**Opt-in and bounded.** Capture is **off by default** — full bodies are large and
privacy-sensitive, and `/metrics` is unauthenticated on localhost. Enable only for a trusted
local dashboard:

```bash
export MTPLX_DASHBOARD_CAPTURE_BODIES=1      # default off; 1/true/yes/on to enable
export MTPLX_DASHBOARD_BODY_MAX_CHARS=20000  # per-field char cap (default 20000; 0 = uncapped)
```

When disabled, the record is byte-for-byte identical to stock MTPLX and the dashboard falls back
to the 180-char preview (see the "showing N of M chars" indicator on the detail page).

### Applying

Pinned against `youssofal/MTPLX` commit `a391973`. From the root of your MTPLX checkout/fork:

```bash
git apply /path/to/mtplx-dashboard/patches/mtplx-full-transcript-capture.patch
# or, to keep it as a commit:
git am < /path/to/mtplx-dashboard/patches/mtplx-full-transcript-capture.patch   # (after adding a From/Subject header)
```

If upstream has moved and the patch no longer applies cleanly, re-target the two anchors by hand —
they're small: the `request_last_user_preview` line in `_request_observability`, and the two
`_dashboard_record_completion(state, envelope=envelope, stats=stats)` call sites.

### Verifying on your box

This patch was authored against a source read and **compile-checked** (`python -m py_compile`),
but it can't be runtime-tested here — MTPLX needs Apple Silicon + MLX + a loaded model. On your
machine:

```bash
MTPLX_DASHBOARD_CAPTURE_BODIES=1 mtplx serve --port 8000
# fire one request, then:
curl -s http://127.0.0.1:8000/metrics | python3 -c 'import sys,json; r=json.load(sys.stdin)["latest"]; print("messages:", len(r.get("request_messages_full") or [])); print("response chars:", len(r.get("response_text") or ""))'
```

You should see a non-zero message count and response length. Flip the env var off and confirm both
fields disappear.
