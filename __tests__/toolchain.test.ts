import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Smoke test confirming the testing toolchain (Vitest + fast-check) is wired up.
 * This does not exercise application logic; feature tests are added in later tasks.
 */
describe('testing toolchain', () => {
  it('runs a basic assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('runs a fast-check property', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 }
    );
  });
});
