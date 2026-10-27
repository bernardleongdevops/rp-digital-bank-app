import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  validateTransferForm,
  isValidAmountString,
  isTransferFormValid,
  MIN_AMOUNT,
  MAX_AMOUNT,
  MAX_DESCRIPTION_LENGTH,
  MESSAGES,
  type TransferFormValues,
} from './transferValidation';
import type { Account } from './types';

/**
 * Feature: customer-banking-app, Property 4: Validation soundness
 *
 * For any Transfer_Form input, client-side validation accepts exactly the
 * inputs that satisfy Requirement 5 and rejects all others. We prove this by
 * comparing `validateTransferForm` / `isValidAmountString` against an
 * INDEPENDENT reference oracle (rebuilt here from the Requirement 5 prose and
 * design bounds, deliberately NOT importing the implementation's regex) and
 * asserting a strict IFF relationship per field, plus totality (never throws).
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
 */

// ---------------------------------------------------------------------------
// Independent reference oracle for the amount rule (Requirement 5.4).
//
// This does NOT reuse the implementation's regex. Instead it inspects the
// trimmed string structurally: it must be a plain unsigned decimal (optional
// integer part, optional fractional part), parse to a finite number, be within
// [MIN_AMOUNT, MAX_AMOUNT], and carry at most two fractional digits. This is an
// independent derivation of "positive number between 0.01 and 999,999,999.99
// with at most two decimal places".
// ---------------------------------------------------------------------------
function oracleAmountValid(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return false;

  // Reject anything that is not composed purely of digits and at most one dot.
  // (No sign, no exponent, no whitespace, no thousands separators, no letters.)
  for (const ch of value) {
    if (!((ch >= '0' && ch <= '9') || ch === '.')) return false;
  }

  const dotCount = value.split('').filter((c) => c === '.').length;
  if (dotCount > 1) return false;

  let intPart: string;
  let fracPart: string;
  if (dotCount === 0) {
    intPart = value;
    fracPart = '';
  } else {
    const idx = value.indexOf('.');
    intPart = value.slice(0, idx);
    fracPart = value.slice(idx + 1);
  }

  // Must have at least one digit somewhere (e.g. ".", "" are invalid; "5", ".5"
  // and "5." are structurally acceptable to the plain-decimal shape).
  if (intPart.length === 0 && fracPart.length === 0) return false;

  // At most two decimal places.
  if (fracPart.length > 2) return false;

  // Numeric value and range. Build the number independently via parseFloat on a
  // normalized string so we are not dependent on the same code path.
  const normalized = (intPart === '' ? '0' : intPart) + (fracPart === '' ? '' : '.' + fracPart);
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n)) return false;
  if (n < MIN_AMOUNT) return false; // > 0 is implied by MIN_AMOUNT = 0.01
  if (n > MAX_AMOUNT) return false;

  return true;
}

// Oracles for the remaining fields, derived directly from Requirement 5.
function oracleFromError(
  values: TransferFormValues,
  owned?: ReadonlyArray<Pick<Account, 'accountNumber'>>,
): boolean {
  const from = values.fromAccount.trim();
  if (from.length === 0) return true; // 5.1 required
  if (owned !== undefined && !owned.some((a) => a.accountNumber === from)) return true;
  return false;
}

function oracleToError(values: TransferFormValues): boolean {
  const from = values.fromAccount.trim();
  const to = values.toAccount.trim();
  if (to.length === 0) return true; // 5.2 required
  if (from.length > 0 && to.length > 0 && from === to) return true; // 5.3 differ
  return false;
}

function oracleDescriptionError(values: TransferFormValues): boolean {
  return values.description.length > MAX_DESCRIPTION_LENGTH; // 5.6
}

// ---------------------------------------------------------------------------
// Generators: mix of valid-shaped and adversarial strings so both branches of
// every IFF are exercised.
// ---------------------------------------------------------------------------

// Account-number-shaped strings and arbitrary junk, including empty/whitespace.
const accountArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constantFrom('ACC-1001', 'ACC-1002', 'ACC-1003'),
  fc.string(),
  fc.string().map((s) => `  ${s}  `),
);

// Amount strings: targeted edge cases plus broad random strings and
// decimal-ish fuzz so the oracle/impl comparison sees valid and invalid forms.
const amountEdgeCases = fc.constantFrom(
  '0',
  '0.00',
  '0.0',
  '0.001',
  '0.01',
  '1.005',
  '1e3',
  '-1',
  '1,000',
  '',
  '   ',
  '  5 ',
  '5',
  '5.',
  '.5',
  '.50',
  '.',
  '..',
  '999999999.99',
  '999999999.999',
  '1000000000',
  '1000000000.00',
  '00.01',
  '0000.1',
  '+5',
  '5.5.5',
  'abc',
  'NaN',
  'Infinity',
  '0x10',
);

const amountDecimalish = fc
  .tuple(
    fc.integer({ min: 0, max: 1_000_000_010 }),
    fc.integer({ min: 0, max: 5 }), // number of fractional digits (0..5 to exceed limit)
  )
  .map(([intp, fracLen]) => {
    if (fracLen === 0) return String(intp);
    // build a fractional part of the requested length
    let frac = '';
    for (let i = 0; i < fracLen; i++) frac += String((intp + i) % 10);
    return `${intp}.${frac}`;
  });

const amountArb = fc.oneof(amountEdgeCases, amountDecimalish, fc.string());

const descriptionArb = fc.oneof(
  fc.constant(''),
  fc.string({ maxLength: 140 }),
  fc.string({ minLength: 139, maxLength: 145 }),
  fc.string({ minLength: 140, maxLength: 140 }),
  fc.string({ minLength: 141, maxLength: 141 }),
  fc.string(),
);

const formArb: fc.Arbitrary<TransferFormValues> = fc.record({
  fromAccount: accountArb,
  toAccount: accountArb,
  amount: amountArb,
  description: descriptionArb,
});

const ownedArb = fc.option(
  fc.array(fc.record({ accountNumber: fc.constantFrom('ACC-1001', 'ACC-1002', 'ACC-1003') }), {
    maxLength: 4,
  }),
  { nil: undefined },
);

const RUNS = 500;

describe('Property 4: validation soundness (isValidAmountString)', () => {
  it('accepts a string IFF it is a plain decimal in [MIN,MAX] with <=2 decimals', () => {
    fc.assert(
      fc.property(amountArb, (raw) => {
        expect(isValidAmountString(raw)).toBe(oracleAmountValid(raw));
      }),
      { numRuns: RUNS },
    );
  });

  it('agrees with the oracle on the enumerated edge cases', () => {
    const cases: Array<[string, boolean]> = [
      ['0', false],
      ['0.00', false],
      ['0.001', false],
      ['1.005', false],
      ['1e3', false],
      ['-1', false],
      ['1,000', false],
      ['', false],
      ['  5 ', true],
      ['999999999.99', true],
      ['1000000000', false],
      ['0.01', true],
      ['.5', true],
      ['5.', true],
    ];
    for (const [raw, expected] of cases) {
      expect(isValidAmountString(raw), `isValidAmountString(${JSON.stringify(raw)})`).toBe(expected);
      expect(oracleAmountValid(raw), `oracle(${JSON.stringify(raw)})`).toBe(expected);
    }
  });

  it('never throws for an arbitrary string (totality)', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => isValidAmountString(raw)).not.toThrow();
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Property 4: validation soundness (validateTransferForm)', () => {
  it('returns a field error IFF that field violates its Requirement 5 rule', () => {
    fc.assert(
      fc.property(formArb, ownedArb, (values, owned) => {
        const errors = validateTransferForm(values, owned ?? undefined);

        // fromAccount (5.1)
        expect(errors.fromAccount !== undefined).toBe(oracleFromError(values, owned ?? undefined));
        // toAccount (5.2 + 5.3)
        expect(errors.toAccount !== undefined).toBe(oracleToError(values));
        // amount (5.4)
        expect(errors.amount !== undefined).toBe(!oracleAmountValid(values.amount));
        // description (5.6)
        expect(errors.description !== undefined).toBe(oracleDescriptionError(values));
      }),
      { numRuns: RUNS },
    );
  });

  it('isTransferFormValid === (no field errors) for any input', () => {
    fc.assert(
      fc.property(formArb, ownedArb, (values, owned) => {
        const errors = validateTransferForm(values, owned ?? undefined);
        const noErrors = Object.keys(errors).length === 0;
        expect(isTransferFormValid(values, owned ?? undefined)).toBe(noErrors);
      }),
      { numRuns: RUNS },
    );
  });

  it('a fully valid form yields no errors and is sent (request allowed)', () => {
    const validAmount = fc.oneof(
      fc.constantFrom('0.01', '5', '5.00', '100.5', '999999999.99', '.5', '5.'),
      fc
        .tuple(fc.integer({ min: 1, max: 999_999_998 }), fc.integer({ min: 0, max: 99 }))
        .map(([i, f]) => `${i}.${String(f).padStart(2, '0')}`),
    );
    fc.assert(
      fc.property(
        fc.record({
          fromAccount: fc.constant('ACC-1001'),
          toAccount: fc.constant('ACC-1002'),
          amount: validAmount,
          description: fc.string({ maxLength: 140 }),
        }),
        (values) => {
          const owned = [{ accountNumber: 'ACC-1001' }, { accountNumber: 'ACC-1002' }];
          expect(isTransferFormValid(values, owned)).toBe(true);
          expect(validateTransferForm(values, owned)).toEqual({});
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never throws for arbitrary string inputs (totality)', () => {
    fc.assert(
      fc.property(formArb, ownedArb, (values, owned) => {
        expect(() => validateTransferForm(values, owned ?? undefined)).not.toThrow();
        expect(() => isTransferFormValid(values, owned ?? undefined)).not.toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  it('enumerated structural edge cases (same/owned/description boundaries)', () => {
    // fromAccount == toAccount -> toAccount error (5.3)
    expect(
      validateTransferForm({
        fromAccount: 'ACC-1001',
        toAccount: 'ACC-1001',
        amount: '5',
        description: '',
      }).toAccount,
    ).toBe(MESSAGES.sameAccount);

    // owned provided but source not owned -> fromAccount error (5.1)
    expect(
      validateTransferForm(
        { fromAccount: 'ACC-9999', toAccount: 'ACC-1002', amount: '5', description: '' },
        [{ accountNumber: 'ACC-1001' }],
      ).fromAccount,
    ).toBe(MESSAGES.fromNotOwned);

    // 140-char description accepted, 141-char rejected (5.5 / 5.6)
    const base = { fromAccount: 'ACC-1001', toAccount: 'ACC-1002', amount: '5' };
    expect(validateTransferForm({ ...base, description: 'a'.repeat(140) }).description).toBeUndefined();
    expect(validateTransferForm({ ...base, description: 'a'.repeat(141) }).description).toBe(
      MESSAGES.descriptionTooLong,
    );
  });
});
