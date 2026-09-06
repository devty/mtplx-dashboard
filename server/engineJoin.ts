/** Engine-measured values for one completed request, as read from the scrape
 *  rather than observed at the wire. */
export interface EngineSample {
  ttftS: number | null;
  decodeTokS: number | null;
}

interface Waiter {
  resolve: (s: EngineSample | null) => void;
  ticks: number;
  /** Wall-clock escape hatch — see the claimTimeoutMs note below. */
  timer: NodeJS.Timeout;
}

/** Joins a proxied request to the engine's own measurement of it.
 *
 *  A non-streaming proxy sees only the finished response: it knows wall-clock
 *  elapsed but not time-to-first-token, and not decode rate separated from
 *  prefill. Those live in the Prometheus histogram, which is up to one poll
 *  interval behind. So the proxy claims, and the scraper settles.
 *
 *  The whole point of this class is the ambiguity rule (spec section 4.2):
 *  Δsum/Δcount is a per-request measurement ONLY when Δcount is exactly 1.
 *  Over any wider interval it is a mean, and this returns null rather than
 *  handing a mean to one request as if it were that request's own. */
export class EngineJoin {
  private waiters: Waiter[] = [];
  private readonly maxTicks: number;
  private readonly maxWaiters: number;
  private readonly claimTimeoutMs: number;

  constructor(opts: { maxTicks?: number; maxWaiters?: number; claimTimeoutMs?: number } = {}) {
    this.maxTicks = opts.maxTicks ?? 3;
    this.maxWaiters = opts.maxWaiters ?? 64;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 15_000;
  }

  /** Single exit for every waiter, so the wall-clock timer is always cleared. */
  private finish(w: Waiter, s: EngineSample | null): void {
    clearTimeout(w.timer);
    w.resolve(s);
  }

  /** Never rejects. Resolves with the engine's sample, or null when no
   *  unambiguous one is available. */
  claim(): Promise<EngineSample | null> {
    return new Promise(resolve => {
      /* Bound the queue: a scraper that stops settling (upstream down, dashboard
         mid-restart) must not accumulate waiters for every request served. */
      if (this.waiters.length >= this.maxWaiters) {
        const oldest = this.waiters.shift();
        if (oldest) this.finish(oldest, null);
      }

      const w: Waiter = { resolve, ticks: 0, timer: undefined as unknown as NodeJS.Timeout };
      /* The tick bound only advances when the scraper settles, and it settles
         only on a SUCCESSFUL scrape. During a /metrics outage nothing settles
         at all, so without this the request row would never be written.

         Deliberately NOT unref'd: an unref'd timer does not fire under
         `node --test`, which made the test for this very fallback unrunnable.
         stop() calls abandon(), which clears every timer, so shutdown is
         already covered without it. */
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          this.finish(w, null);
        }
      }, this.claimTimeoutMs);
      this.waiters.push(w);
    });
  }

  /** Called by the scraper once per successful tick. */
  settle(completedDelta: number | null, sample: EngineSample): void {
    const n = completedDelta ?? 0;

    if (n === 1 && this.waiters.length > 0) {
      this.finish(this.waiters.shift()!, sample);
    } else if (n > 1) {
      /* A mean across several requests — nobody gets it. If the delta exceeds
         the queue (a client bypassing the proxy) the surplus is simply
         discarded; there is no waiter it could belong to. */
      for (let i = 0; i < n && this.waiters.length > 0; i++) {
        this.finish(this.waiters.shift()!, null);
      }
    }

    /* Age whoever is left. A tick landing between response-end and claim
       consumes the delta with nobody waiting, so an uncovered waiter must
       eventually give up or its request row is never written. */
    const survivors: Waiter[] = [];
    for (const w of this.waiters) {
      if (++w.ticks >= this.maxTicks) this.finish(w, null);
      else survivors.push(w);
    }
    this.waiters = survivors;
  }

  /** Restart or shutdown: nothing pending can still be answered truthfully. */
  abandon(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) this.finish(w, null);
  }

  pending(): number {
    return this.waiters.length;
  }
}
