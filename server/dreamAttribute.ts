/** Assigns cycle blocks to sources.
 *
 *  This is separated from dreamParse.ts because it is the component most
 *  likely to be wrong and most likely to need revision when gbrain changes its
 *  output. Keeping it apart means a change here cannot destabilise parsing.
 *
 *  WHY THIS IS NOT TRIVIAL. The intuitive rule — "a block belongs to the next
 *  `stamped last_full_cycle_at for X`" — is wrong. A source emits TWO blocks:
 *  a per-source group, then, after its own stamp, a heavy group. Observed
 *  2026-09-05:
 *
 *      Dream cycle (partial) in 1.4s:      <- default, per-source phases
 *      stamped … for default
 *      Dream cycle (partial) in 812.4s:    <- default AGAIN, heavy phases
 *      stamped … for calendar
 *
 *  Applying the intuitive rule files default's heaviest work under calendar:
 *  the busiest source looks idle and a trivial one looks enormous, silently.
 *
 *  The disambiguator is the phase set. The two groups are disjoint, so a
 *  block's own phases say which group it is, and therefore which stamp it
 *  belongs to. When the phases match neither group we return `unknown` rather
 *  than guessing — confidently-wrong attribution in an ops view gets acted on,
 *  which is worse than a visible gap. */

import type { DreamRunRecord } from './dreamParse';

/** Phases the per-source group emits, before that source is stamped. */
export const PER_SOURCE_PHASES: ReadonlySet<string> = new Set([
  'lint',
  'backlinks',
  'sync',
  'extract',
  'extract_facts',
  'recompute_emotional_weight',
]);

/** Phases the heavy group emits, AFTER its source is stamped. */
export const MIXED_PHASES: ReadonlySet<string> = new Set([
  'extract_atoms',
  'consolidate',
  'propose_takes',
  'conversation_facts_backfill',
  'enrich_thin',
  'schema-suggest',
]);

export function attributeRun(run: DreamRunRecord): void {
  for (const cycle of run.cycles) {
    const names = cycle.phases.map((p) => p.phase);
    const heavy = names.some((n) => MIXED_PHASES.has(n));
    const light = names.some((n) => PER_SOURCE_PHASES.has(n));

    /* Both groups in one block would mean gbrain merged them — the rule no
       longer holds and we must not pretend otherwise. */
    if (heavy === light) {
      cycle.sourceId = null;
      cycle.attribution = 'unknown';
      continue;
    }

    if (heavy) {
      // Belongs to the most recently stamped source.
      const idx = cycle.precedingStampIndex;
      if (idx >= 0 && idx < run.stamps.length) {
        cycle.sourceId = run.stamps[idx];
        cycle.attribution = 'inferred';
      } else {
        cycle.sourceId = null;
        cycle.attribution = 'unknown';
      }
      continue;
    }

    // Light: belongs to the NEXT source stamped after this block.
    const next = cycle.precedingStampIndex + 1;
    if (next < run.stamps.length) {
      cycle.sourceId = run.stamps[next];
      cycle.attribution = 'stamped';
    } else {
      cycle.sourceId = null;
      cycle.attribution = 'unknown';
    }
  }
}
