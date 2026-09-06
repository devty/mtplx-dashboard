# Dream log fixtures

Real excerpts from `~/.gbrain/dream-nightly.log`, one complete run each.

| File | Shape it pins |
|---|---|
| `completed-run.txt` | `starting` → phases → commit → `done (dream exit=0)` |
| `warned-run.txt` | `WARN … (rc=143)`, commits present, **no** `done` line |
| `truncated-run.txt` | Stops dead: no WARN, no commit, no `done` |
| `attribution-trap.txt` | A source's heavy block emitted *after* its own stamp (Task 2) |
| `missed-gap.txt` | Two runs spanning a night that never fired (Task 4) |
| `failed-phase-run.txt` | A phase that failed outright (`✗` at two-space indent) with its `[InternalError/CODE]` detail line, a nested item failure (`✗` at six-space indent) in the same run, and thirteen full-import informational lines — both halves of the F1 finding in one run |

These are verbatim. Do not tidy them — the whitespace, the box-drawing marks and
the interleaved `Brain is healthy.` noise are all part of what the parser must
survive.
