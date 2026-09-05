import { findSample } from './promParse';
import type { PromScrape } from './promParse';
import { detectRestart } from './promSeries';
import type { Store, RunInfo } from './db';

export interface RunTrackerDeps {
  targetId: string;
  store: Pick<Store, 'upsertRun'>;
}

/** Value of the label `key` on the series of `name` whose value is 1.
 *  rapid-mlx emits config as one-hot gauges — kv_cache_dtype{dtype="bf16"} 1
 *  alongside int8/int4 at 0 — so the active setting is the labelled series
 *  carrying the 1, not a value to be read directly. */
function activeLabel(scrape: PromScrape, name: string, key: string): string | null {
  for (const s of scrape.samples) {
    if (s.name === name && s.value === 1 && s.labels[key] !== undefined) return s.labels[key];
  }
  return null;
}

/** First value seen for `key` across any series of `name`. Used for labels that
 *  are constant per process (the spec-decode method), where the value on the
 *  series is a counter and irrelevant. */
function anyLabel(scrape: PromScrape, name: string, key: string): string | null {
  for (const s of scrape.samples) {
    if (s.name === name && s.labels[key] !== undefined) return s.labels[key];
  }
  return null;
}

/** How far the derived origin must move before it counts as a restart rather
 *  than clock or scrape jitter. Jitter moves it by milliseconds; a restart
 *  moves it by the whole previous uptime. */
const RESTART_EPSILON_MS = 30_000;

export class RunTracker {
  private runId: number | null = null;
  private model: string | null = null;
  private version: string | null = null;
  /** Held stable between restarts — see the comment in observe(). */
  private startedAt: number | null = null;
  private prevUptimeS: number | null = null;
  /** `now` of the last successful observation — the reference the origin test
   *  compares against, so it holds across arbitrarily long scrape outages. */
  private lastObservedAt: number | null = null;
  private restarted = false;

  constructor(private readonly deps: RunTrackerDeps) {}

  observe(scrape: PromScrape, health: unknown, contextWindow: number | null, now: number): void {
    const uptime = findSample(scrape, 'rapid_mlx_uptime_seconds');
    const uptimeS = uptime && Number.isFinite(uptime.value) ? uptime.value : null;
    if (uptimeS === null) return; // nothing to key a run on

    const build = findSample(scrape, 'rapid_mlx_build_info');
    this.version = build?.labels.version ?? this.version;
    this.model = build?.labels.model ?? this.model;

    const derivedStart = Math.round(now - uptimeS * 1000);
    const isFirst = this.startedAt === null;

    /* Two independent restart signals (ruling R9). The decrease test catches
       the ordinary case immediately. The origin test catches what the decrease
       test cannot see at all: a restart during a scrape outage longer than the
       new uptime, where uptime returns HIGHER than we last saw it. If the
       process started after we last looked, it is a new process, whatever the
       uptime says. */
    const jumpedPastLastLook =
      this.lastObservedAt !== null && derivedStart > this.lastObservedAt + RESTART_EPSILON_MS;
    this.restarted = !isFirst && (detectRestart(this.prevUptimeS, uptimeS) || jumpedPastLastLook);

    this.prevUptimeS = uptimeS;
    this.lastObservedAt = now;

    /* Derive the origin ONLY on first sight and on restart, then hold it.
       uptime_seconds carries ms precision and scrape timing jitters, so
       recomputing every poll would wander the origin by a few ms and the
       UNIQUE(target_id, started_at) index would mint a new run every second. */
    if (isFirst || this.restarted) {
      this.startedAt = derivedStart;
    } else {
      return; // steady state: the run already exists, nothing to write
    }

    const info: RunInfo = {
      targetId: this.deps.targetId,
      startedAt: this.startedAt,
      model: this.model,
      version: this.version,
      kvCacheDtype: activeLabel(scrape, 'rapid_mlx_kv_cache_dtype', 'dtype'),
      turboquantMode: activeLabel(scrape, 'rapid_mlx_turboquant_mode', 'mode'),
      specDecodeMethod: anyLabel(scrape, 'rapid_mlx_spec_decode_attempts_total', 'method'),
      engineType:
        typeof (health as { engine_type?: unknown })?.engine_type === 'string'
          ? (health as { engine_type: string }).engine_type
          : null,
      contextWindow,
      health: JSON.stringify({
        health,
        buildInfo: { version: this.version, model: this.model, labels: build?.labels ?? {} },
      }),
    };

    this.runId = this.deps.store.upsertRun(info, now, { adopt: isFirst && !this.restarted });
  }

  getRunId(): number | null { return this.runId; }
  getModel(): string | null { return this.model; }
  getVersion(): string | null { return this.version; }
  didRestart(): boolean { return this.restarted; }
}
