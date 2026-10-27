import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { SubmitGuard } from './transferSubmit';

/**
 * Property 7: Idempotent submit guard (task 9.4).
 *
 * Validates: Requirements 4.2 — WHILE a Transfer request is in progress, the
 * Transfer_Form SHALL disable the submit control to prevent duplicate
 * submission, so that at most one outbound POST /api/bff/transfers is issued
 * per completed request cycle.
 *
 * The SubmitGuard is the single source of truth for "is a request in flight".
 * `begin()` grants permission to issue the outbound POST by returning `true`,
 * and must do so AT MOST ONCE per in-flight cycle: between a true-returning
 * `begin()` and the next `end()`, every other `begin()` must return `false`.
 * After `end()`, a fresh `begin()` may return `true` again.
 *
 * We verify this by driving the guard through arbitrary `begin`/`end`
 * sequences and comparing each `begin()` result against an INDEPENDENT
 * reference model of the invariant.
 */
describe('SubmitGuard — Property 7: Idempotent submit guard (Validates: Requirements 4.2)', () => {
  type Op = 'begin' | 'end';

  it('begin() grants permission at most once per in-flight cycle, matching an independent reference model', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Op>('begin', 'end'), { minLength: 0, maxLength: 200 }),
        (ops) => {
          const guard = new SubmitGuard();

          // Independent reference state machine for the expected invariant.
          let modelInFlight = false;

          for (const op of ops) {
            if (op === 'begin') {
              // Model: a begin is granted (true) iff currently idle, and that
              // grant latches in-flight. Otherwise it is denied (false).
              const expectedGranted = !modelInFlight;
              if (expectedGranted) modelInFlight = true;

              const actualGranted = guard.begin();

              // Each begin() result must match the model exactly.
              expect(actualGranted).toBe(expectedGranted);
              // The guard's own in-flight view must track the model.
              expect(guard.isInFlight()).toBe(modelInFlight);
            } else {
              // Model: end always clears in-flight.
              modelInFlight = false;
              guard.end();
              expect(guard.isInFlight()).toBe(false);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('between a granted begin() and the next end(), every other begin() is denied', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Op>('begin', 'end'), { minLength: 0, maxLength: 200 }),
        (ops) => {
          const guard = new SubmitGuard();
          let inFlight = false;
          let grantsThisCycle = 0; // begins granted since the last end()

          for (const op of ops) {
            if (op === 'begin') {
              const granted = guard.begin();
              if (inFlight) {
                // Already in a cycle: any further begin must be denied.
                expect(granted).toBe(false);
              } else {
                // Idle: this begin opens a new cycle and must be granted.
                expect(granted).toBe(true);
                grantsThisCycle += 1;
                inFlight = true;
              }
              // Never more than one grant outstanding within a single cycle.
              expect(grantsThisCycle).toBeLessThanOrEqual(1);
            } else {
              guard.end();
              inFlight = false;
              grantsThisCycle = 0;
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('higher-level guarantee: N runTransfer-style cycles never exceed 1 in flight and keep grants/ends balanced', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 25 }), // number of concurrent cycles
        async (n) => {
          const guard = new SubmitGuard();

          let posts = 0; // outbound POSTs actually issued (begin() === true)
          let grantedBegins = 0; // begin() calls that observed an idle guard (=== true)
          let ends = 0; // end() calls made for granted cycles
          let completedCycles = 0; // cycles that reached their finally
          let concurrentInFlight = 0; // live count of cycles currently in flight
          let maxConcurrent = 0;

          // Simulate a runTransfer cycle: call begin() before an awaited async
          // op, issue the POST only when granted, and end() in finally.
          const runTransfer = async (): Promise<void> => {
            const granted = guard.begin();
            if (granted) grantedBegins += 1;
            try {
              if (granted) {
                posts += 1;
                concurrentInFlight += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrentInFlight);
                // Yield to the event loop to interleave with other cycles.
                await Promise.resolve();
                await Promise.resolve();
                concurrentInFlight -= 1;
              }
            } finally {
              if (granted) {
                guard.end();
                ends += 1;
              }
              completedCycles += 1;
            }
          };

          // Fire N cycles "concurrently" (microtask-interleaved on one thread).
          // With Promise.all, the first cycle latches the guard in-flight and
          // awaits before later cycles call begin(), so later cycles that start
          // WHILE one is in flight are correctly DENIED. The guard's purpose is
          // to prevent duplicate in-flight submits, so NOT every cycle is granted.
          await Promise.all(Array.from({ length: n }, () => runTransfer()));

          // Every launched cycle ran its finally.
          expect(completedCycles).toBe(n);
          // The guard must never permit more than one cycle in flight at a time.
          expect(maxConcurrent).toBeLessThanOrEqual(1);
          // A POST is issued exactly when a begin() observed an idle guard.
          expect(posts).toBe(grantedBegins);
          // Grants and ends are balanced: every granted cycle releases the guard.
          expect(ends).toBe(grantedBegins);
          // At least one cycle is granted, and never more than the number of cycles.
          expect(posts).toBeGreaterThanOrEqual(1);
          expect(posts).toBeLessThanOrEqual(n);
          // Guard is released at the end.
          expect(guard.isInFlight()).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('interleaved concurrent cycles with a shared await point still grant at most one in flight', async () => {
    // Stronger interleaving: all cycles call begin() first (synchronously in a
    // row) BEFORE any await, so only the first can be granted; the rest must be
    // denied. This models a burst of double-clicks arriving before end() runs.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 50 }), async (n) => {
        const guard = new SubmitGuard();

        const begins = Array.from({ length: n }, () => guard.begin());

        // Exactly one begin may have been granted while the guard stayed latched.
        const granted = begins.filter(Boolean).length;
        const maxConcurrent = begins[0] ? 1 : 0;

        await Promise.resolve();

        expect(granted).toBe(1);
        expect(maxConcurrent).toBeLessThanOrEqual(1);

        guard.end();
        expect(guard.isInFlight()).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
