# MTPLX patches

Local patches for the upstream inference server ([`youssofal/MTPLX`](https://github.com/youssofal/MTPLX)).
These are **not** submitted upstream — they're a local patch you apply to your own MTPLX
install so this dashboard can show data the stock server doesn't expose.

> **This patch is destroyed by every MTPLX upgrade.** It edits the *installed* package, so any
> `pip install mtplx` — which includes every MTPLX.app update that re-provisions the runtime venv —
> silently reverts it. See [Re-applying after an upgrade](#re-applying-after-an-upgrade).

## `mtplx-full-transcript-capture.patch`

**What it does.** Stock MTPLX `/metrics` only carries a 180-char preview of the *last* user
message and **no assistant response body** (the generated text is used to build the HTTP reply
and then discarded — only a 120-char preview reaches stdout logs). This patch adds two optional
fields to each completed-request record so the dashboard's per-request detail page can render the
**full prompt** and the **full response**:

- `request_messages_full` — `[{ role, content }, …]`, the complete prompt transcript. Added in
  `_request_observability(...)`, which is merged into every completion envelope, so one edit
  covers the streaming, AR-batch, MTP-batch, and smart-fan paths.
- `response_text` — the finished assistant text, stamped onto the latest record via a small
  `_dashboard_capture_response_text(...)` helper at **all three** completion sites:
  `_finalize_batched_ar_generation` (ar_batch), `_finalize_mtp_batch_generation`
  (the mtp_batch cohort scheduler added in 2.6.0), and `_run_generation` (serial).

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

Pinned against **MTPLX 2.6.0** (`mtplx-2.6.0-py3-none-any.whl`,
sha256 `8f2323c3212d1d62e3a5954059f2c91c30322632ffc5c192611fc6951b2a8521`).

The target is the **installed package**, not a git checkout. On a stock MTPLX.app install that
means the app-provisioned runtime venv:

```bash
VENV="$HOME/Library/Application Support/MTPLX/runtime-venv"
SP="$VENV/lib/python3.14/site-packages"          # adjust python3.X to match

cd "$SP"
patch -p1 --dry-run --forward < /path/to/mtplx-dashboard/patches/mtplx-full-transcript-capture.patch
patch -p1 --forward           < /path/to/mtplx-dashboard/patches/mtplx-full-transcript-capture.patch
"$VENV/bin/python" -m py_compile "$SP/mtplx/server/openai.py"
```

Then restart the server so it loads the patched module.

**On version drift.** `patch` locates hunks by surrounding context, not line number, so large
offsets are expected and harmless — re-applying this against a newer MTPLX will report offsets in
the thousands and still succeed. Read the `--dry-run --verbose` output for *failed* hunks only;
do **not** try to sanity-check the reported "succeeded at" line numbers, because hunk #1's number
points at the inserted helper definition rather than a call site and reads alarmingly wrong.
Verify placement by enclosing function instead:

```bash
grep -n '_dashboard_capture_response_text(state' "$SP/mtplx/server/openai.py"
```

You want four hits: the `def`, plus one inside each of the three finalize/run functions named
above.

If a hunk genuinely fails, the anchors are small and easy to re-target by hand: the
`request_last_user_preview` line in `_request_observability`, and each
`_dashboard_record_completion(state, envelope=envelope, stats=stats)` call site.

**Watch for new completion sites.** Upstream adds these as it adds schedulers — 2.6.0 introduced
`_finalize_mtp_batch_generation` and the then-current patch silently stopped capturing responses
on that path. After any upgrade, confirm the counts match:

```bash
grep -c '_dashboard_record_completion(state, envelope=envelope, stats=stats)' "$SP/mtplx/server/openai.py"
grep -c '_dashboard_capture_response_text(state,' "$SP/mtplx/server/openai.py"
```

If `record_completion` exceeds `capture_response_text`, upstream added a path this patch doesn't
cover; add the one-liner after the new `_dashboard_record_completion(...)` call and regenerate
this patch.

### Re-applying after an upgrade

The failure is **silent and asymmetric**, which is what makes it worth automating:
`MTPLX_DASHBOARD_CAPTURE_BODIES=1` typically lives in your launchd plist or shell profile and
survives forever, while the code that reads it lives in site-packages and is destroyed. Post-
upgrade the server is healthy, the env var is set, and the dashboard just quietly shows previews.

Detect and repair in one step:

```bash
npm run mtplx:postupgrade          # check only
npm run mtplx:postupgrade -- --fix # re-apply if missing, then verify
```

See [`scripts/mtplx-postupgrade.sh`](../scripts/mtplx-postupgrade.sh). It also catches the
related MTPLX.app trap where Sparkle updates the app bundle but leaves the runtime venv on an
older `mtplx`, so `mtplx --version` and the app's About box disagree.

### Verifying on your box

```bash
# with MTPLX_DASHBOARD_CAPTURE_BODIES=1 in the server's environment, fire one request, then:
curl -s http://127.0.0.1:8000/metrics | python3 -c 'import sys,json; r=json.load(sys.stdin)["latest"]; print("messages:", len(r.get("request_messages_full") or [])); print("response chars:", len(r.get("response_text") or ""))'
```

You should see a non-zero message count and response length. Flip the env var off and confirm both
fields disappear. To check the dashboard end of the wire too:

```bash
curl -s http://127.0.0.1:8123/api/metrics | grep -c request_messages_full
```
