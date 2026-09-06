/** gbrain dream-log parser. Pure: no I/O, no state, no clock.
 *
 *  Hand-rolled for the same reason promParse.ts is: the grammar is small and
 *  irregular, and the irregularities (a phase block that appears after its own
 *  source's stamp, marks drawn from a box-drawing character set) are exactly
 *  what a general-purpose parser would normalise away.
 *
 *  Attribution of blocks to sources is NOT done here — see dreamAttribute.ts.
 *  Blocks come back with sourceId null. */

/** `failed` is the phase's own verdict — the phase aborted and produced
 *  nothing. It is NOT the same as `noop` (`!`), which means the phase ran to
 *  completion and had nothing to apply, and it is not the same as a nested item
 *  failure (see DreamItemFailure), which is one item failing inside a phase
 *  that otherwise ran. Both `✗` shapes exist in the log at different indents;
 *  see RE_PHASE / RE_FAILURE. */
export type DreamMark = 'ran' | 'skipped' | 'noop' | 'failed';
export type DreamTermination = 'completed' | 'warned' | 'truncated' | 'running';
export type DreamAttribution = 'stamped' | 'inferred' | 'unknown';
export type DreamCycleScope = 'source' | 'global';

/** One item — a page, a slug — that failed inside a phase that itself ran. */
export interface DreamItemFailure {
  slug: string;
  message: string;
}

/** The `[Class/CODE] detail` line gbrain prints beneath a phase that failed
 *  outright. Kept apart from DreamItemFailure rather than squeezed into its
 *  {slug, message}: `code` is a machine classification of why the PHASE died
 *  (`PATTERNS_CHILD_DEAD`), not the name of an item that died inside it. Filing
 *  it as a slug would render a whole-phase abort as though one page had failed,
 *  which is precisely the reading this view must not produce. An array because
 *  nothing in the log's grammar promises exactly one — a second detail line
 *  would be recorded, not silently overwrite the first. */
export interface DreamPhaseError {
  code: string;
  detail: string;
}

export interface DreamPhaseLine {
  mark: DreamMark;
  phase: string;
  text: string;
  failures: DreamItemFailure[];
  errors: DreamPhaseError[];
}

export interface DreamCycleBlock {
  ordinal: number;
  durationS: number;
  phases: DreamPhaseLine[];
  /** Filled in by dreamAttribute.ts, not here. */
  sourceId: string | null;
  attribution: DreamAttribution;
  /** Filled in by dreamAttribute.ts, not here. `global` is the brain-wide pass
   *  (spec section 6 wants it as its own row, not folded into a source and not
   *  dumped into the unattributed bucket, which exists to carry real doubt). */
  scope: DreamCycleScope;
  /** Index into DreamRunRecord.stamps of the stamp immediately preceding this
   *  block. -1 when the block precedes every stamp. Attribution needs this and
   *  it is only knowable while scanning. */
  precedingStampIndex: number;
}

export interface DreamRunRecord {
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  globalPassRc: number | null;
  termination: DreamTermination;
  /** Source ids in the order the run declared it would cycle them. */
  sources: string[];
  /** Source ids in the order they were actually stamped. */
  stamps: string[];
  /** source id -> sha, from [dream-nightly:commit] lines. */
  committedShas: Map<string, string>;
  cycles: DreamCycleBlock[];
  /** Ordinal of the cycle block that follows the `global pass (brain-wide
   *  phases, once)` marker, or null when the run never printed one. Purely
   *  positional — what the marker MEANS is dreamAttribute's call. May point one
   *  past the end when the run died before the pass emitted a block. */
  globalPassCycleOrdinal: number | null;
  /** Byte offset of this run's `starting` line within the parsed text. */
  offset: number;
}

export interface DreamParseResult {
  runs: DreamRunRecord[];
  unrecognisedCount: number;
  unrecognisedSamples: string[];
  /** Byte offset of the last run that has no terminator, or null if every run
   *  in this text is terminated. Ingest rewinds here so a run that was still
   *  running at parse time is re-evaluated rather than frozen. */
  lastIncompleteRunOffset: number | null;
}

const RE_START = /^\[dream-nightly\]\s+(.+?)\s+starting$/;
const RE_DONE = /^\[dream-nightly\]\s+(.+?)\s+done \(dream exit=(-?\d+)\)$/;
const RE_WARN = /^\[dream-nightly\]\s+WARN: global pass failed \(rc=(-?\d+)\)$/;
const RE_SOURCES = /^\[dream-nightly\]\s+cycling sources:\s*(.*?)\s*$/;
const RE_STAMP = /^\[dream-nightly\]\s+stamped last_full_cycle_at for (\S+)$/;
const RE_COMMIT = /^\[dream-nightly:commit\]\s+(\S+)\s+committed\s+(\S+)$/;
/* The brain-wide pass announces itself, then emits one ordinary `Dream cycle`
   block. Without capturing the marker that block is indistinguishable from a
   source's, and lands in the unattributed bucket — burying the largest single
   thing in the run under the label that is supposed to mean "we don't know". */
const RE_GLOBAL_PASS = /^\[dream-nightly\] global pass \(brain-wide phases, once\)$/;
/* The parenthesised word is a completion reason ("partial", "ok", and
   presumably others we haven't seen yet) — not part of the grammar we care
   about, so it is matched but not captured. Every reason must land here: if a
   reason fell through to NOISE instead, the stale `cycle` from the previous
   source's block would still be open and its phase lines would silently
   attach to the wrong cycle instead of tripping the unrecognised counter. */
const RE_CYCLE = /^Dream cycle \([a-z]+\) in ([\d.]+)s:\s*$/;
/* The two `✗` shapes are told apart by indent alone, and the log is consistent
   about it: a PHASE mark sits at exactly two spaces, a nested item failure at
   six. RE_PHASE's ` {2}` is exact, not a minimum — a six-space line has a space
   at index 2, which is not in the mark class — and RE_FAILURE requires four or
   more, so neither regex can reach the other's lines. They are checked in that
   knowledge, not in a particular order. */
const RE_PHASE = /^ {2}([✓✗!-]) (\S+)\s{1,}(.*)$/;
const RE_FAILURE = /^ {4,}✗ ([^:]+):\s*(.*)$/;
/* `      [InternalError/PATTERNS_CHILD_DEAD] subagent job 10701 outcome 'dead'`
   — the classification line beneath a failed phase, at the nested indent. */
const RE_PHASE_ERROR = /^ {4,}\[([A-Za-z][A-Za-z0-9]*\/[A-Z][A-Z0-9_]*)\]\s+(\S.*)$/;

/* Lines that are known, carry no record, and must not inflate the
   unrecognised count — that count is the format-drift canary and is worthless
   if ordinary noise lands in it. Each entry below is a nameable line kind
   found in the real log (see server/fixtures/dream/), not a speculative
   catch-all. */
const NOISE = [
  /^Brain is healthy\./,
  /^No stale pages/,
  /^ {2}totals: /,
  /* Sub-tagged dream-nightly loggers. One entry per tag rather than a
     `[dream-nightly:...]` catch-all, so a NEW tag — a new subsystem talking
     for the first time — reaches the drift canary instead of being absorbed. */
  /^\[dream-nightly:(patch|export|mtplx|parity|commit|orphans|worker|fullsync)\]/,
  /* `global pass brain dir: …` and `global pass ok`. The `(brain-wide phases,
     once)` marker is NOT noise and is consumed above. `cycling sources` and
     `stamped` are deliberately absent: they have their own regexes, so a
     variant either matches those or must trip the drift canary. */
  /^\[dream-nightly\] global pass /,
  // Post-cycle extraction summaries (incremental extract runs outside the
  // per-source Dream cycle block, after a phase like text-import lands).
  /^Extract --stale: /,
  /^Incremental extract: /,
  /^Text imported\. Run /,
  // Backlink-candidate pruning notice ("N candidate(s) ...").
  /^Skipped \d+ candidate\(s\) whose target page doesn't exist/,
  /* Backlink candidates dropped because the target is in a different source.
     Two wordings, both from the cross-source rule; each is spelled out rather
     than reduced to a shared `^Skipped \d+` stem, which would also swallow
     wordings nobody has read. */
  /^Skipped \d+ candidate\(s\) whose target page exists only in another source/,
  /^Skipped \d+ cross-source candidate\(s\) — target exists only in another source/,
  // Lock contention: another cycle already held the per-source lock.
  /^Skipped: another cycle is already running\./,
  /* A `gbrain import` running under the dream prints its own progress block.
     None of it is per-phase: the phase line that owns the import reports the
     outcome separately, so these are duplicate detail, not lost signal. */
  /^Running full import of \S.*\(\d+ workers\)\.\.\.$/,
  /^Found \d+ markdown files$/,
  /^Using \d+ parallel workers$/,
  /^Large sync \(\d+ files\)\. Importing text, deferring embeddings\.$/,
  /^Import complete \([\d.]+s\):$/,
  /^ {2}\d+ pages imported$/,
  /^ {2}\d+ pages skipped \(\d+ unchanged, \d+ errors\)$/,
  /^ {2}\d+ chunks created$/,
  /^ {2}Deleted un-syncable page: \S+$/,
  // Sync-planner gates: why this pass chose a full re-chunk / tree diff.
  /^\[sync\] chunker_version gate: stored=\d+, current=\d+\./,
  /^\[sync\] last_commit \S+ not an ancestor of HEAD\b/,
  /* Operator annotations around hand-run invocations. They mark a manual run,
     they are not one: the run itself still opens on its own `starting` line, so
     skipping these loses nothing the run record does not already hold. */
  /^=== marker: .* ===$/,
  /^={5,} RUN START .* ={5,}$/,
  /^\[dream-nightly\] === MANUAL RUN .* ===$/,
  /^ *$/,
];

const MARKS: Record<string, DreamMark> = {
  '✓': 'ran',
  '✗': 'failed',
  '-': 'skipped',
  '!': 'noop',
};

export function parseDreamLog(text: string): DreamParseResult {
  const runs: DreamRunRecord[] = [];
  const unrecognisedSamples: string[] = [];
  let unrecognisedCount = 0;

  let run: DreamRunRecord | null = null;
  let cycle: DreamCycleBlock | null = null;
  let lastPhase: DreamPhaseLine | null = null;
  let offset = 0;

  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the \n we split on

    const start = RE_START.exec(line);
    if (start) {
      /* Date.parse only understands a handful of timezone abbreviations — CEST,
         BST and JST all return NaN where EDT/EST/UTC/GMT parse. The line MATCHED
         the run-boundary shape, so nothing downstream would notice: NaN flows
         into localDate() as "NaN-NaN-NaN" and into a NOT NULL INTEGER column.
         Refuse to open the run and count it, so the drift canary is loud. */
      const startedAt = Date.parse(start[1]);
      if (!Number.isFinite(startedAt)) {
        run = null;
        cycle = null;
        lastPhase = null;
        unrecognisedCount++;
        if (unrecognisedSamples.length < 20) unrecognisedSamples.push(line);
        continue;
      }
      run = {
        startedAt,
        endedAt: null,
        exitCode: null,
        globalPassRc: null,
        termination: 'running',
        sources: [],
        stamps: [],
        committedShas: new Map(),
        cycles: [],
        globalPassCycleOrdinal: null,
        offset: lineOffset,
      };
      runs.push(run);
      cycle = null;
      lastPhase = null;
      continue;
    }

    if (!run) continue; // preamble before the first run boundary

    const done = RE_DONE.exec(line);
    if (done) {
      /* The `done` line itself is the evidence of completion; its timestamp is
         decoration, so an unparseable one costs the end time, not the verdict. */
      const endedAt = Date.parse(done[1]);
      run.endedAt = Number.isFinite(endedAt) ? endedAt : null;
      run.exitCode = Number(done[2]);
      run.termination = 'completed';
      cycle = null;
      lastPhase = null;
      continue;
    }

    const warn = RE_WARN.exec(line);
    if (warn) {
      run.globalPassRc = Number(warn[1]);
      continue;
    }

    const sources = RE_SOURCES.exec(line);
    if (sources) {
      run.sources = sources[1].split(/\s+/).filter(Boolean);
      continue;
    }

    const stamp = RE_STAMP.exec(line);
    if (stamp) {
      run.stamps.push(stamp[1]);
      continue;
    }

    const commit = RE_COMMIT.exec(line);
    if (commit) {
      run.committedShas.set(commit[1], commit[2]);
      continue;
    }

    if (RE_GLOBAL_PASS.test(line)) {
      /* The next block opened is the global pass's. Recorded as a position, not
         resolved to a meaning — that is dreamAttribute's job. */
      run.globalPassCycleOrdinal = run.cycles.length;
      continue;
    }

    const cyc = RE_CYCLE.exec(line);
    if (cyc) {
      cycle = {
        ordinal: run.cycles.length,
        durationS: Number(cyc[1]),
        phases: [],
        sourceId: null,
        attribution: 'unknown',
        scope: 'source',
        precedingStampIndex: run.stamps.length - 1,
      };
      run.cycles.push(cycle);
      lastPhase = null;
      continue;
    }

    const fail = RE_FAILURE.exec(line);
    if (fail && lastPhase) {
      lastPhase.failures.push({ slug: fail[1].trim(), message: fail[2].trim() });
      continue;
    }

    /* Guarded on lastPhase for the same reason RE_FAILURE is: an error line with
       no phase above it is drift, and must reach the counter rather than be
       quietly dropped. */
    const perr = RE_PHASE_ERROR.exec(line);
    if (perr && lastPhase) {
      lastPhase.errors.push({ code: perr[1], detail: perr[2].trim() });
      continue;
    }

    const phase = RE_PHASE.exec(line);
    if (phase && cycle) {
      lastPhase = {
        mark: MARKS[phase[1]],
        phase: phase[2],
        text: phase[3].trim(),
        failures: [],
        errors: [],
      };
      cycle.phases.push(lastPhase);
      continue;
    }

    if (NOISE.some((re) => re.test(line))) continue;

    unrecognisedCount++;
    if (unrecognisedSamples.length < 20) unrecognisedSamples.push(line);
  }

  /* A run that saw a WARN but never a `done` line got far enough for its trap
     to run; one that saw neither was killed outright. These have different
     causes and different remedies, so they stay distinct. */
  for (const r of runs) {
    if (r.termination !== 'running') continue;
    if (r.globalPassRc !== null || r.committedShas.size > 0) r.termination = 'warned';
    else r.termination = 'truncated';
  }

  const last = runs[runs.length - 1];
  const lastIncompleteRunOffset =
    last && last.termination !== 'completed' ? last.offset : null;

  return { runs, unrecognisedCount, unrecognisedSamples, lastIncompleteRunOffset };
}

/** `git log --format='%h %ad %s' --date=short` output → date → sha, keeping
 *  only the dream's own auto-commits. Pure; the shelling lives in ingest. */
export function parseDreamCommits(gitLog: string): Map<string, string> {
  const out = new Map<string, string>();
  const RE = /^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+dream: auto-commit gbrain writes\b/;
  for (const line of gitLog.split('\n')) {
    const m = RE.exec(line.trim());
    if (m && !out.has(m[2])) out.set(m[2], m[1]);
  }
  return out;
}
