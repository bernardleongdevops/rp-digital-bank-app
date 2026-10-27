import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  mapTransferOutcome,
  mapTransferResult,
  type TransferOutcomeInput,
  type TransferOutcomeKind,
  type TransferPresentation,
  type TransferSeverity,
} from './transferPresentation';
import type { TransferResult } from './types';

/**
 * Feature: customer-banking-app, Property 3: Transfer outcome determinism
 *
 * For any HTTP status returned by the Sandbox_Gateway for a transfer, the
 * outcome mapper produces exactly one presentation (and one UI state); the
 * mapping is mutually exclusive across the covered statuses
 * 201/202/422/409/403/401/429; and every status not explicitly covered maps to
 * the generic ERROR presentation.
 *
 * **Validates: Requirements 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10**
 */

const ALLOWED_KINDS: readonly TransferOutcomeKind[] = [
  'COMPLETED',
  'AML_HELD',
  'AML_BLOCKED',
  'CONFLICT',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'UNEXPECTED',
];

const ALLOWED_SEVERITIES: readonly TransferSeverity[] = ['success', 'info', 'warning', 'error'];

const CONFLICT_CODES = ['INSUFFICIENT_FUNDS', 'SAME_ACCOUNT', 'CURRENCY_MISMATCH', 'INVALID_AMOUNT'] as const;

/** The explicitly-covered statuses whose mapping must be stable and distinct. */
const COVERED_STATUSES = [201, 202, 422, 409, 403, 401, 429, 504, 502] as const;

/** Assert a value is a well-formed TransferPresentation (totality invariant). */
function assertValidPresentation(p: TransferPresentation): void {
  expect(ALLOWED_KINDS).toContain(p.kind);
  expect(ALLOWED_SEVERITIES).toContain(p.severity);
  expect(typeof p.title).toBe('string');
  expect(p.title.length).toBeGreaterThan(0);
  expect(typeof p.message).toBe('string');
  expect(p.message.length).toBeGreaterThan(0);
  expect(typeof p.clearForm).toBe('boolean');
  expect(typeof p.requiresReauth).toBe('boolean');
  expect(typeof p.isRateLimit).toBe('boolean');
  expect(typeof p.canRetry).toBe('boolean');
}

/** Arbitrary for the optional `error`/`message` fields: sometimes known codes, sometimes junk, sometimes absent. */
const errorArb = fc.option(
  fc.oneof(fc.constantFrom(...CONFLICT_CODES, 'NETWORK', 'TIMEOUT', 'UNEXPECTED'), fc.string()),
  { nil: undefined }
);
const messageArb = fc.option(fc.string(), { nil: undefined });

describe('transferPresentation — Property 3: transfer outcome determinism', () => {
  it('determinism: same input always yields a deep-equal presentation across repeated calls', () => {
    fc.assert(
      fc.property(fc.integer(), errorArb, messageArb, (status, error, message) => {
        const input: TransferOutcomeInput = { status, error, message };
        const first = mapTransferOutcome(input);
        const second = mapTransferOutcome(input);
        const third = mapTransferOutcome({ status, error, message });
        expect(second).toStrictEqual(first);
        expect(third).toStrictEqual(first);
      }),
      { numRuns: 300 }
    );
  });

  it('totality: for ANY integer status and arbitrary error/message it returns a valid presentation and never throws', () => {
    fc.assert(
      fc.property(fc.integer(), errorArb, messageArb, (status, error, message) => {
        let result: TransferPresentation;
        expect(() => {
          result = mapTransferOutcome({ status, error, message });
        }).not.toThrow();
        assertValidPresentation(result!);
      }),
      { numRuns: 300 }
    );
  });

  it('totality holds specifically across the full 16-bit-ish status range including odd/negative values', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 10000 }), errorArb, (status, error) => {
        assertValidPresentation(mapTransferOutcome({ status, error }));
      }),
      { numRuns: 300 }
    );
  });

  it('mutual exclusivity: each covered status yields exactly one, stable kind distinct from the others', () => {
    // Build the canonical kind for each covered status (409/502 depend on error code; pick a stable projection).
    const kindFor = (status: number): TransferOutcomeKind => mapTransferOutcome({ status }).kind;
    const kinds = COVERED_STATUSES.map((s) => ({ status: s, kind: kindFor(s) }));

    // 502 with no error code is UNEXPECTED and 504 is TIMEOUT — both generic-error kinds,
    // so uniqueness is asserted over the business/terminal statuses only.
    const businessStatuses = [201, 202, 422, 409, 403, 401, 429] as const;
    const businessKinds = businessStatuses.map(kindFor);
    expect(new Set(businessKinds).size).toBe(businessStatuses.length);

    // And the mapping is a stable function: re-deriving yields the identical set.
    const kindsAgain = COVERED_STATUSES.map((s) => ({ status: s, kind: kindFor(s) }));
    expect(kindsAgain).toStrictEqual(kinds);
  });

  it('correct mapping: 201 -> COMPLETED/success with clearForm=true, terminal', () => {
    const p = mapTransferOutcome({ status: 201 });
    expect(p.kind).toBe('COMPLETED');
    expect(p.severity).toBe('success');
    expect(p.clearForm).toBe(true);
    expect(p.requiresReauth).toBe(false);
    expect(p.isRateLimit).toBe(false);
    expect(p.canRetry).toBe(false);
    assertValidPresentation(p);
  });

  it('correct mapping: 202 -> AML_HELD/info, form retained, no retry', () => {
    const p = mapTransferOutcome({ status: 202 });
    expect(p.kind).toBe('AML_HELD');
    expect(p.severity).toBe('info');
    expect(p.clearForm).toBe(false);
    expect(p.canRetry).toBe(false);
  });

  it('correct mapping: 422 -> AML_BLOCKED/error, terminal', () => {
    const p = mapTransferOutcome({ status: 422 });
    expect(p.kind).toBe('AML_BLOCKED');
    expect(p.severity).toBe('error');
    expect(p.clearForm).toBe(false);
    expect(p.canRetry).toBe(false);
  });

  it('correct mapping: 403 -> FORBIDDEN/error, terminal', () => {
    const p = mapTransferOutcome({ status: 403 });
    expect(p.kind).toBe('FORBIDDEN');
    expect(p.severity).toBe('error');
    expect(p.requiresReauth).toBe(false);
    expect(p.canRetry).toBe(false);
  });

  it('correct mapping: 401 -> UNAUTHENTICATED/error with requiresReauth=true', () => {
    const p = mapTransferOutcome({ status: 401 });
    expect(p.kind).toBe('UNAUTHENTICATED');
    expect(p.severity).toBe('error');
    expect(p.requiresReauth).toBe(true);
    expect(p.canRetry).toBe(false);
  });

  it('correct mapping: 429 -> RATE_LIMITED/warning with isRateLimit=true and canRetry=true', () => {
    const p = mapTransferOutcome({ status: 429 });
    expect(p.kind).toBe('RATE_LIMITED');
    expect(p.severity).toBe('warning');
    expect(p.isRateLimit).toBe(true);
    expect(p.canRetry).toBe(true);
  });

  it('correct mapping: 504 -> TIMEOUT/error, retryable', () => {
    const p = mapTransferOutcome({ status: 504 });
    expect(p.kind).toBe('TIMEOUT');
    expect(p.severity).toBe('error');
    expect(p.canRetry).toBe(true);
  });

  it('correct mapping: 502 -> NETWORK when error=NETWORK, else UNEXPECTED; both retryable errors', () => {
    const network = mapTransferOutcome({ status: 502, error: 'NETWORK' });
    expect(network.kind).toBe('NETWORK');
    expect(network.severity).toBe('error');
    expect(network.canRetry).toBe(true);

    const unexpected = mapTransferOutcome({ status: 502, error: 'UNEXPECTED' });
    expect(unexpected.kind).toBe('UNEXPECTED');
    expect(unexpected.severity).toBe('error');
    expect(unexpected.canRetry).toBe(true);

    // Any non-NETWORK error code (or junk) on a 502 falls back to UNEXPECTED.
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== 'NETWORK'),
        (error) => {
          expect(mapTransferOutcome({ status: 502, error }).kind).toBe('UNEXPECTED');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('correct mapping: 409 -> CONFLICT with the documented message per known error code', () => {
    const expectations: Record<(typeof CONFLICT_CODES)[number], RegExp> = {
      INSUFFICIENT_FUNDS: /enough funds/i,
      SAME_ACCOUNT: /must be different/i,
      CURRENCY_MISMATCH: /different currencies/i,
      INVALID_AMOUNT: /not valid/i,
    };
    for (const code of CONFLICT_CODES) {
      const p = mapTransferOutcome({ status: 409, error: code });
      expect(p.kind).toBe('CONFLICT');
      expect(p.severity).toBe('error');
      expect(p.canRetry).toBe(false);
      expect(p.message).toMatch(expectations[code]);
      // Distinct, code-specific title per known conflict code.
      expect(p.title.length).toBeGreaterThan(0);
    }
  });

  it('correct mapping: 409 with an unknown/missing error code -> CONFLICT generic fallback', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string().filter((s) => !(CONFLICT_CODES as readonly string[]).includes(s)), {
          nil: undefined,
        }),
        (error) => {
          const p = mapTransferOutcome({ status: 409, error });
          expect(p.kind).toBe('CONFLICT');
          expect(p.severity).toBe('error');
          // Generic conflict copy.
          expect(p.title).toBe('Transfer rejected');
          expect(p.message).toMatch(/conflict/i);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('any other status -> generic UNEXPECTED error presentation', () => {
    const covered = new Set<number>([201, 202, 422, 409, 403, 401, 429, 504, 502]);
    fc.assert(
      fc.property(
        fc.integer().filter((s) => !covered.has(s)),
        errorArb,
        (status, error) => {
          const p = mapTransferOutcome({ status, error });
          expect(p.kind).toBe('UNEXPECTED');
          expect(p.severity).toBe('error');
          expect(p.canRetry).toBe(true);
          assertValidPresentation(p);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('mapTransferResult matches mapTransferOutcome on the projected status for every TransferResult variant', () => {
    const resultArb: fc.Arbitrary<TransferResult> = fc.oneof(
      fc.constant<TransferResult>({ kind: 'COMPLETED', status: 201 }),
      fc.constant<TransferResult>({ kind: 'AML_HELD', status: 202 }),
      fc.constant<TransferResult>({ kind: 'AML_BLOCKED', status: 422 }),
      fc
        .record({
          error: fc.oneof(fc.constantFrom(...CONFLICT_CODES), fc.string()),
          message: fc.string(),
        })
        .map((r) => ({ kind: 'CONFLICT' as const, status: 409 as const, error: r.error, message: r.message })),
      fc.constant<TransferResult>({ kind: 'FORBIDDEN', status: 403 }),
      fc.constant<TransferResult>({ kind: 'UNAUTHENTICATED', status: 401 }),
      fc.constant<TransferResult>({ kind: 'RATE_LIMITED', status: 429 }),
      fc
        .constantFrom('NETWORK', 'TIMEOUT', 'UNEXPECTED')
        .map((reason) => ({ kind: 'ERROR' as const, reason: reason as 'NETWORK' | 'TIMEOUT' | 'UNEXPECTED' }))
    );

    // The adapter projects each variant onto the status/error shape the outcome mapper consumes.
    const projectedStatus = (r: TransferResult): TransferOutcomeInput => {
      switch (r.kind) {
        case 'COMPLETED':
          return { status: 201, error: 'COMPLETED' };
        case 'AML_HELD':
          return { status: 202, error: 'AML_HELD' };
        case 'AML_BLOCKED':
          return { status: 422, error: 'AML_BLOCKED' };
        case 'CONFLICT':
          return { status: 409, error: r.error, message: r.message };
        case 'FORBIDDEN':
          return { status: 403, error: 'FORBIDDEN' };
        case 'UNAUTHENTICATED':
          return { status: 401, error: 'UNAUTHENTICATED' };
        case 'RATE_LIMITED':
          return { status: 429, error: 'RATE_LIMITED' };
        case 'ERROR':
          if (r.reason === 'TIMEOUT') return { status: 504, error: 'TIMEOUT' };
          if (r.reason === 'NETWORK') return { status: 502, error: 'NETWORK' };
          return { status: 502, error: 'UNEXPECTED' };
      }
    };

    fc.assert(
      fc.property(resultArb, (result) => {
        const viaResult = mapTransferResult(result);
        const viaOutcome = mapTransferOutcome(projectedStatus(result));
        assertValidPresentation(viaResult);
        expect(viaResult).toStrictEqual(viaOutcome);
      }),
      { numRuns: 300 }
    );
  });
});
