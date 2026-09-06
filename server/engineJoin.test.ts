import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineJoin } from './engineJoin';
import type { EngineSample } from './engineJoin';

const S = (ttftS: number, decodeTokS: number): EngineSample => ({ ttftS, decodeTokS });

test('exactly one completion resolves the single waiter with the sample', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const p = j.claim();
  j.settle(1, S(0.39, 36.7));
  assert.deepEqual(await p, { ttftS: 0.39, decodeTokS: 36.7 });
  assert.equal(j.pending(), 0);
});

/* Δsum/Δcount over an interval covering several requests is a MEAN. Handing
   it to one request would fabricate a per-request measurement. */
test('several completions in one interval resolve every covered waiter to null', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const a = j.claim(), b = j.claim(), c = j.claim();
  j.settle(3, S(0.5, 30));
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(await c, null);
});

test('a partial interval resolves only the oldest waiters, in order', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const first = j.claim(), second = j.claim();
  j.settle(1, S(0.2, 40));
  assert.deepEqual(await first, { ttftS: 0.2, decodeTokS: 40 });
  assert.equal(j.pending(), 1);
  j.settle(1, S(0.9, 12));
  assert.deepEqual(await second, { ttftS: 0.9, decodeTokS: 12 });
});

test('a quiet tick resolves nobody', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const p = j.claim();
  j.settle(0, S(1, 1));
  j.settle(null, S(1, 1));
  assert.equal(j.pending(), 1);
  j.settle(1, S(0.3, 22));
  assert.deepEqual(await p, { ttftS: 0.3, decodeTokS: 22 });
});

/* A tick can land between the response ending and the claim registering; the
   delta is then consumed with nobody waiting. Without a bound the claim would
   never settle and the request row would never be written. */
test('a waiter never covered resolves null after maxTicks', async () => {
  const j = new EngineJoin({ maxTicks: 3 });
  const p = j.claim();
  j.settle(0, S(1, 1));
  j.settle(0, S(1, 1));
  assert.equal(j.pending(), 1);
  j.settle(0, S(1, 1));
  assert.equal(await p, null);
  assert.equal(j.pending(), 0);
});

/* Someone curling the upstream directly produces completions the proxy never
   saw, so the delta can exceed the queue. */
test('more completions than waiters resolves all of them to null', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const a = j.claim(), b = j.claim();
  j.settle(5, S(0.4, 30));
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(j.pending(), 0);
});

test('overflow resolves the oldest waiter rather than growing without bound', async () => {
  const j = new EngineJoin({ maxWaiters: 2, claimTimeoutMs: 40 });
  const a = j.claim();
  j.claim();
  j.claim();                      // pushes a out
  assert.equal(await a, null);
  assert.equal(j.pending(), 2);
});

test('abandon resolves everything to null', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const a = j.claim(), b = j.claim();
  j.abandon();
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.equal(j.pending(), 0);
});

/* settle() runs only on a SUCCESSFUL scrape, so during a /metrics outage
   nothing settles and the tick bound never advances. Without a wall-clock
   fallback the proxy's persist() would never run and the request would vanish
   from the log — exactly when the log matters most. */
test('a claim resolves null on its own when the scraper never settles', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 30 });
  const p = j.claim();
  assert.equal(await p, null);
  assert.equal(j.pending(), 0);
});

test('the wall-clock timer is cleared when a claim settles normally', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 30 });
  const p = j.claim();
  j.settle(1, S(0.2, 40));
  assert.deepEqual(await p, { ttftS: 0.2, decodeTokS: 40 });
  /* Nothing pending, and no stray timer may fire later against a resolved
     promise or hold the event loop open. */
  await new Promise(r => setTimeout(r, 50));
  assert.equal(j.pending(), 0);
});

test('claims never reject', async () => {
  const j = new EngineJoin({ claimTimeoutMs: 200 });
  const p = j.claim();
  j.settle(1, { ttftS: null, decodeTokS: null });
  assert.deepEqual(await p, { ttftS: null, decodeTokS: null });
});
