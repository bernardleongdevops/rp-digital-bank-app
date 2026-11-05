/**
 * Pure, framework-free client-side validation for the Transfer_Form
 * (Requirement 5). This module is intentionally free of React and of any
 * server-only import so it can be:
 *   - called from the `TransferForm` client component to block invalid
 *     submissions and render field-level errors (Requirement 5.1-5.6), and
 *   - imported directly by the Property 4 "Validation soundness" test
 *     (task 9.3) to assert soundness across arbitrary inputs.
 *
 * The validator operates on the RAW form values (strings, as typed by the
 * customer) rather than a parsed `TransferRequest`, because the amount rules
 * (numeric, at most two decimal places) are about the typed text, not an
 * already-parsed number. The bounds mirror the server-side BFF validation in
 * `app/api/bff/transfers/route.ts` (MIN 0.01, MAX 999,999,999.99, at most two
 * decimals, description <= 140) so the client and server agree.
 *
 * No secrets, no gateway URLs, safe for both server and client.
 */

import type { Account, Recurrence } from './types';

/** Inclusive transfer amount bounds, matching the server-side BFF rule. */
export const MIN_AMOUNT = 0.01;
export const MAX_AMOUNT = 999_999_999.99;

/** Maximum transfer description length (Requirement 5.6). */
export const MAX_DESCRIPTION_LENGTH = 140;

/**
 * The raw, as-typed values of the Transfer_Form. `amount` is a string because
 * the numeric/decimal rules (Requirement 5.4) are about the typed text; an
 * empty string represents an untouched/cleared field.
 */
export interface TransferFormValues {
  fromAccount: string;
  toAccount: string;
  amount: string;
  description: string;
}

/**
 * Field-level validation errors. A field maps to a human-readable, accessible
 * message only when it violates a rule; a field with no entry is absent.
 * An empty object therefore means "valid, safe to submit".
 */
export interface TransferFormErrors {
  fromAccount?: string;
  toAccount?: string;
  amount?: string;
  description?: string;
}

/** Human-readable, accessible validation messages (Requirement 5.1-5.6). */
export const MESSAGES = {
  fromRequired: 'A source account is required.',
  fromNotOwned: 'Select one of your own accounts as the source.',
  toRequired: 'A destination account is required.',
  sameAccount: 'The source and destination accounts must be different.',
  amountInvalid:
    'The amount must be a positive number between 0.01 and 999,999,999.99 with at most two decimal places.',
  descriptionTooLong: 'The description must be 140 characters or fewer.',
  // Saved_Payee creation (Requirement 5.2/5.13).
  payeeLabelRequired: 'A payee label is required.',
  payeeDestinationRequired: 'A destination account is required.',
  // Scheduled_Transfer scheduling (Requirement 6.3) and recurrence (6.1).
  scheduleDateRequired: 'A schedule date is required.',
  scheduleDateInvalid: 'Enter a valid schedule date.',
  scheduleDateNotFuture: 'The schedule date must be after the current date.',
  recurrenceInvalid: 'Select a supported recurrence.',
} as const;

/**
 * The supported recurrence set, including the one-off option (Requirement
 * 6.1). Declared as a runtime tuple so the validator can check membership
 * without a type-only cast; kept in lock-step with the `Recurrence` type in
 * `./types`.
 */
export const RECURRENCE_VALUES: readonly Recurrence[] = [
  'ONCE',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
] as const;

/**
 * Return true when the trimmed, as-typed `amount` string denotes a valid
 * transfer amount: a plain decimal number, strictly greater than 0, within
 * [MIN_AMOUNT, MAX_AMOUNT], with at most two decimal places.
 *
 * The check is done on the text (not a pre-parsed number) so that
 * `"1.005"` (three decimals) and non-numeric text are rejected, and so an
 * empty field is treated as "missing" rather than `0`.
 */
export function isValidAmountString(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return false;

  // Plain decimal only: optional integer part, optional fractional part of at
  // most two digits. No signs, exponents, whitespace, or thousands separators.
  // Accepts "5", "5.", "5.0", "5.00", ".5", "0.01" and rejects "1e3", "-1",
  // "1.005", "abc", "1,000".
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) return false;

  const amount = Number(value);
  if (!Number.isFinite(amount)) return false;
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) return false;

  return true;
}

/**
 * Validate the raw Transfer_Form values against Requirement 5, returning a map
 * of field-level errors. An empty returned object means every rule passed and
 * the request may be sent; a non-empty object means the request MUST NOT be
 * sent (Requirement 5.1-5.6).
 *
 * Rules:
 *   5.1 `fromAccount` non-empty (and, when `ownedAccounts` is provided, one of
 *       the customer's own accounts).
 *   5.2 `toAccount` non-empty.
 *   5.3 `fromAccount !== toAccount`.
 *   5.4 `amount` numeric, > 0, within 0.01..999,999,999.99, <= 2 decimals.
 *   5.5/5.6 `description` 0..140 chars.
 *
 * `ownedAccounts` is optional so the pure rules can be exercised without a
 * populated account list; when supplied, the source account must be owned.
 */
export function validateTransferForm(
  values: TransferFormValues,
  ownedAccounts?: ReadonlyArray<Pick<Account, 'accountNumber'>>,
): TransferFormErrors {
  const errors: TransferFormErrors = {};

  const from = values.fromAccount.trim();
  const to = values.toAccount.trim();

  // 5.1 source account required (and owned, when the account list is known).
  if (from.length === 0) {
    errors.fromAccount = MESSAGES.fromRequired;
  } else if (
    ownedAccounts !== undefined &&
    !ownedAccounts.some((a) => a.accountNumber === from)
  ) {
    errors.fromAccount = MESSAGES.fromNotOwned;
  }

  // 5.2 destination account required.
  if (to.length === 0) {
    errors.toAccount = MESSAGES.toRequired;
  }

  // 5.3 source and destination must differ. Only meaningful once both are
  // present; reported on the destination field so the message sits with the
  // control the customer most likely needs to change.
  if (from.length > 0 && to.length > 0 && from === to) {
    errors.toAccount = MESSAGES.sameAccount;
  }

  // 5.4 amount numeric, positive, in range, at most two decimals.
  if (!isValidAmountString(values.amount)) {
    errors.amount = MESSAGES.amountInvalid;
  }

  // 5.5/5.6 description length 0..140.
  if (values.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = MESSAGES.descriptionTooLong;
  }

  return errors;
}

/** Convenience predicate: true when the form passes every rule. */
export function isTransferFormValid(
  values: TransferFormValues,
  ownedAccounts?: ReadonlyArray<Pick<Account, 'accountNumber'>>,
): boolean {
  return Object.keys(validateTransferForm(values, ownedAccounts)).length === 0;
}

// ===========================================================================
// Banking App Realism — Saved_Payee validation (Requirements 5.2, 5.13).
//
// The same pure rules run on the client (to block invalid create-payee
// submissions and render field-level errors) and are re-applied server-side in
// the POST /api/bff/payees route for parity (Property 3). Framework-free, no
// secrets.
// ===========================================================================

/**
 * The raw, as-typed values of the create-payee form. Both fields are strings
 * because the only rule is "non-empty after trimming" (Requirement 5.2); an
 * empty string represents an untouched/cleared field.
 */
export interface PayeeFormValues {
  label: string;
  destinationAccount: string;
}

/**
 * Field-level create-payee errors. A field maps to a message only when it
 * violates a rule; an empty object means "valid, safe to submit".
 */
export interface PayeeFormErrors {
  label?: string;
  destinationAccount?: string;
}

/**
 * Validate the raw create-payee values against Requirement 5.2/5.13, returning
 * a map of field-level errors. An empty returned object means every rule
 * passed and the request may be sent; a non-empty object means the request
 * MUST NOT be sent.
 *
 * Rules:
 *   5.2 `label` non-empty (after trimming).
 *   5.2 `destinationAccount` non-empty (after trimming).
 */
export function validatePayeeForm(values: PayeeFormValues): PayeeFormErrors {
  const errors: PayeeFormErrors = {};

  if (values.label.trim().length === 0) {
    errors.label = MESSAGES.payeeLabelRequired;
  }

  if (values.destinationAccount.trim().length === 0) {
    errors.destinationAccount = MESSAGES.payeeDestinationRequired;
  }

  return errors;
}

/** Convenience predicate: true when the create-payee form passes every rule. */
export function isPayeeFormValid(values: PayeeFormValues): boolean {
  return Object.keys(validatePayeeForm(values)).length === 0;
}

// ===========================================================================
// Banking App Realism — Scheduled_Transfer validation (Requirements 6.2, 6.3).
//
// Reuses `validateTransferForm` unchanged for the money/account fields so the
// scheduled form is validated identically to the Transfer_Form (Requirement
// 6.2), then layers the schedule-date and recurrence rules on top. The same
// pure rules are re-applied server-side in the POST /api/bff/scheduled-transfers
// route for parity (Property 3). Framework-free, no secrets.
// ===========================================================================

/**
 * The raw, as-typed values of the scheduled-transfer form. Extends the
 * Transfer_Form values with a `scheduleDate` (ISO 8601 date string, as typed)
 * and a `recurrence` selected from the supported set.
 */
export interface ScheduledTransferFormValues extends TransferFormValues {
  scheduleDate: string; // ISO 8601 date, as typed
  recurrence: Recurrence;
}

/**
 * Field-level scheduled-transfer errors. Extends `TransferFormErrors` with the
 * schedule-date and recurrence fields. An empty object means "valid".
 */
export interface ScheduledTransferFormErrors extends TransferFormErrors {
  scheduleDate?: string;
  recurrence?: string;
}

/**
 * Validate the raw scheduled-transfer values against Requirements 6.2 and 6.3,
 * returning a map of field-level errors. An empty returned object means every
 * rule passed and the request may be sent; a non-empty object means the
 * request MUST NOT be sent.
 *
 * Rules:
 *   6.2 Reuse `validateTransferForm` for `fromAccount` / `toAccount` /
 *       `amount` / `description` (identical to the Transfer_Form rules).
 *   6.3 `scheduleDate` must be a valid date strictly AFTER `now`.
 *   6.1 `recurrence` must be one of the supported `RECURRENCE_VALUES`.
 *
 * `now` is passed in (rather than read from the clock) so the rule is pure and
 * deterministic for both the client and the server-side re-check.
 * `ownedAccounts` is forwarded to `validateTransferForm` for the source-owned
 * check when the account list is known.
 */
export function validateScheduledTransferForm(
  values: ScheduledTransferFormValues,
  now: Date,
  ownedAccounts?: ReadonlyArray<Pick<Account, 'accountNumber'>>,
): ScheduledTransferFormErrors {
  // 6.2 money/account fields validated exactly as the Transfer_Form.
  const errors: ScheduledTransferFormErrors = validateTransferForm(
    values,
    ownedAccounts,
  );

  // 6.3 schedule date: present, parseable, and strictly after `now`.
  const rawDate = values.scheduleDate.trim();
  if (rawDate.length === 0) {
    errors.scheduleDate = MESSAGES.scheduleDateRequired;
  } else {
    const scheduled = new Date(rawDate);
    const scheduledMs = scheduled.getTime();
    if (Number.isNaN(scheduledMs)) {
      errors.scheduleDate = MESSAGES.scheduleDateInvalid;
    } else if (scheduledMs <= now.getTime()) {
      errors.scheduleDate = MESSAGES.scheduleDateNotFuture;
    }
  }

  // 6.1 recurrence must be one of the supported values.
  if (!RECURRENCE_VALUES.includes(values.recurrence)) {
    errors.recurrence = MESSAGES.recurrenceInvalid;
  }

  return errors;
}

/** Convenience predicate: true when the scheduled-transfer form passes every rule. */
export function isScheduledTransferFormValid(
  values: ScheduledTransferFormValues,
  now: Date,
  ownedAccounts?: ReadonlyArray<Pick<Account, 'accountNumber'>>,
): boolean {
  return (
    Object.keys(validateScheduledTransferForm(values, now, ownedAccounts))
      .length === 0
  );
}
