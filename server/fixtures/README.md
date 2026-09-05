# Prometheus scrape fixtures

Captured 2026-09-05 from the two live rapid-mlx 0.13.4 servers. Used as golden
inputs for `promParse` tests.

- `rapid-mlx-0.13.4-cold.txt` — qwen `:8000` after a restart, before any request.
  59 metric families. **Perishable**: this state only exists between a restart
  and the first completion, so it cannot be re-captured on demand. It is the case
  that proves `prefix_cache_*` and the `_max`/`_last` gauges are absent until
  first traffic — a parser assuming a fixed family set passes against every other
  fixture and fails here.
- `rapid-mlx-0.13.4-after-first-request.txt` — the same server after one
  completion. 73 families. Diff against the cold fixture for the 14 that appear.
- `rapid-mlx-0.13.4-gemma.txt` — gemma `:8087`, for the differing `family` label
  (`gemma4` vs `qwen3.6`) and `model` label.

The `model` label is a full filesystem snapshot path containing `--` separators
and 40-char hashes. That is deliberate and must round-trip through the parser
unchanged — it is the realistic worst case for label-value handling.
