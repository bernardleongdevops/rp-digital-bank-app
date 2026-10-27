/**
 * Transfer outcome -> UI presentation mapper (task 6.1).
 *
 * This module is the single, pure, deterministic, and *total* mapping from a
 * transfer outcome to a user-facing presentation model. It is deliberately
 * free of any server-only import and carries no secrets, so it is safe to run
 * in the browser: the Transfer_Form calls `POST /api/bff/transfers`, reads the
 * `{ status, error, message? }` JSON the BFF returns, and feeds it straight to
 * {@link mapTransferOutcome} to decide what the result banner shows.
 *
 * Design references:
 *   - requirements.md Requirements 4.3-4.10 (one distinct state per outcome).
 *   - design.md "Transfer outcome mapping" table and the `TransferResult`
 *     discriminated union.
 *   - The BFF contract in `app/api/bff/transfers/route.ts` /
 *     `app/api/bff/_lib/respond.ts`: the browser-facing status mirrors the
 *     upstream transfer semantics 1:1 (201/202/422/409/403/401/429/504/502),
 *     with the 409 `error` code + `message` forwarded, and TIMEOUT/NETWORK/
 *     UNEXPECTED surfaced as 504/502.
 *
 * Correctness Property 3 (transfer outcome determinism): for *any* status the
 * mapper yields exactly one presentation; the covered statuses are mutually
 * exclusive; every uncovered status maps to the generic error presentation.
 * The sibling property test (task 6.3) relies on this function being pure and
 * total, so there is intentionally no I/O, randomness, time, or throwing here.
 */

import type { TransferResult } from './types';

/**
 * Visual severity / variant the result banner renders. Mirrors the common
 * alert vocabulary so the UI can pick a colour/icon per outcome:
 *   - `success` — the transfer completed.
 *   - `info`    — accepted but not final (held for AML review).
 *   - `warning` — a recoverable, non-error condition (rate limited).
 *   - `error`   — the transfer did not go through.
 */
export type TransferSeverity = 'success' | 'info' | 'warning' | 'error';

/**
 * A stable, machine-readable discriminator for the outcome, independent of the
 * raw HTTP status. The UI (and tests) can branch on this without re-deriving
 * the status, and it stays in sync with the `TransferResult.kind` vocabulary
 * plus the extra transport reasons the BFF can surface (TIMEOUT/NETWORK).
 */
export type TransferOutcomeKind =
  | 'COMPLETED'
  | 'AML_HELD'
  | 'AML_BLOCKED'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNEXPECTED';

/**
 * The deterministic, user-facing presentation model for one transfer outcome.
 * Everything the result banner needs is here; it carries no secret and no raw
 * upstream payload beyond a safe, human-readable `message`.
 */
export interface TransferPresentation {
  /** Stable discriminator for the outcome (not the raw HTTP status). */
  kind: TransferOutcomeKind;
  /** Banner severity / colour family. */
  severity: TransferSeverity;
  /** Short human-readable title (e.g. "Transfer completed"). */
  title: string;
  /** Longer human-readable explanation suitable for display to the customer. */
  message: string;
  /**
   * Whether the UI should clear the Transfer_Form on this outcome. Only a
   * fully completed transfer clears the form; every other outcome retains the
   * entered values so the customer can retry or correct them (Requirement
   * 4.10 retains values on error, and there is no reason to discard input on a
   * held/blocked/conflict outcome either).
   */
  clearForm: boolean;
  /**
   * Whether this outcome means the customer must re-authenticate. True only
   * for a 401 (Requirement 4.8): the caller routes to re-authentication.
   */
  requiresReauth: boolean;
  /**
   * Whether this outcome is a rate-limit (HTTP 429, Requirement 4.9). The UI
   * uses this to show a "retry after a short delay" affordance and to suppress
   * any automatic retry (Requirement 8.7).
   */
  isRateLimit: boolean;
  /**
   * Whether the UI should offer a retry action that re-initiates the same
   * request. True for transient transport failures and unexpected errors
   * (Requirement 4.10) and for rate limiting (after a delay, Requirement 4.9).
   * False for terminal business outcomes (completed/held/blocked/conflict/
   * forbidden) and for re-auth, where retrying the identical request is not
   * the right next step.
   */
  canRetry: boolean;
}

/** The shape the browser receives from `POST /api/bff/transfers`. */
export interface TransferOutcomeInput {
  /** The browser-facing HTTP status mirrored from the upstream outcome. */
  status: number;
  /**
   * Machine-readable code. For a 409 this is the business conflict code
   * (INSUFFICIENT_FUNDS | SAME_ACCOUNT | CURRENCY_MISMATCH | INVALID_AMOUNT);
   * for the transport failures it is TIMEOUT | NETWORK | UNEXPECTED; otherwise
   * it echoes the outcome name. Optional and never trusted for branching
   * except for the 409 sub-code.
   */
  error?: string;
  /** Optional non-secret human-readable message (forwarded only for 409). */
  message?: string;
}

/**
 * Human-readable copy for each 409 business conflict `error` code
 * (Requirement 4.6). Any unknown or missing code falls back to a generic
 * conflict explanation so the mapping stays total.
 */
const CONFLICT_COPY: Record<string, { title: string; message: string }> = {
  INSUFFICIENT_FUNDS: {
    title: 'Insufficient funds',
    message: 'The source account does not have enough funds for this transfer.',
  },
  SAME_ACCOUNT: {
    title: 'Same account',
    message: 'The source and destination accounts must be different.',
  },
  CURRENCY_MISMATCH: {
    title: 'Currency mismatch',
    message: 'The source and destination accounts use different currencies.',
  },
  INVALID_AMOUNT: {
    title: 'Invalid amount',
    message: 'The transfer amount is not valid for this account.',
  },
};

/** Build the presentation for a 409 business conflict from its `error` code. */
function presentConflict(errorCode: string | undefined): TransferPresentation {
  // Only match *own*, known conflict codes. A plain object literal inherits
  // Object.prototype members (`__proto__`, `valueOf`, `toString`, etc.), so a
  // bare `CONFLICT_COPY[errorCode]` would resolve those inherited keys instead
  // of `undefined` and skip the generic fallback, breaking totality. Guarding
  // with `Object.hasOwn` ensures every unknown/inherited key falls through.
  const known =
    errorCode !== undefined && Object.hasOwn(CONFLICT_COPY, errorCode)
      ? CONFLICT_COPY[errorCode]
      : undefined;
  const copy = known ?? {
    title: 'Transfer rejected',
    message: 'This transfer could not be completed due to a conflict.',
  };
  return {
    kind: 'CONFLICT',
    severity: 'error',
    title: copy.title,
    message: copy.message,
    clearForm: false,
    requiresReauth: false,
    isRateLimit: false,
    canRetry: false,
  };
}

/** The generic error presentation for transport failures and any uncovered status. */
function presentGenericError(kind: 'TIMEOUT' | 'NETWORK' | 'UNEXPECTED'): TransferPresentation {
  const copy: Record<typeof kind, { title: string; message: string }> = {
    TIMEOUT: {
      title: 'Transfer timed out',
      message: 'The transfer did not complete in time. Please try again.',
    },
    NETWORK: {
      title: 'Connection problem',
      message: 'We could not reach the service. Check your connection and try again.',
    },
    UNEXPECTED: {
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Your transfer was not sent. Please try again.',
    },
  };
  return {
    kind,
    severity: 'error',
    title: copy[kind].title,
    message: copy[kind].message,
    clearForm: false,
    requiresReauth: false,
    isRateLimit: false,
    canRetry: true,
  };
}

/**
 * Map a transfer outcome (the BFF `{ status, error?, message? }` response) to
 * exactly one {@link TransferPresentation}.
 *
 * Totality: the switch covers every explicitly-handled status; the `default`
 * branch funnels the transport-error statuses (504 TIMEOUT, 502 NETWORK/
 * UNEXPECTED) and *every other* status to the generic error presentation. The
 * function therefore returns a value for any integer `status` and never throws.
 */
export function mapTransferOutcome(input: TransferOutcomeInput): TransferPresentation {
  switch (input.status) {
    case 201:
      return {
        kind: 'COMPLETED',
        severity: 'success',
        title: 'Transfer completed',
        message: 'Your transfer was completed successfully.',
        clearForm: true,
        requiresReauth: false,
        isRateLimit: false,
        canRetry: false,
      };
    case 202:
      return {
        kind: 'AML_HELD',
        severity: 'info',
        title: 'Transfer held for review',
        message: 'Your transfer is being reviewed and will be processed once checks are complete.',
        clearForm: false,
        requiresReauth: false,
        isRateLimit: false,
        canRetry: false,
      };
    case 422:
      return {
        kind: 'AML_BLOCKED',
        severity: 'error',
        title: 'Transfer blocked',
        message: 'This transfer was blocked by our compliance controls and cannot proceed.',
        clearForm: false,
        requiresReauth: false,
        isRateLimit: false,
        canRetry: false,
      };
    case 409:
      return presentConflict(input.error);
    case 403:
      return {
        kind: 'FORBIDDEN',
        severity: 'error',
        title: 'Not allowed',
        message: 'You are not the owner of the source account for this transfer.',
        clearForm: false,
        requiresReauth: false,
        isRateLimit: false,
        canRetry: false,
      };
    case 401:
      return {
        kind: 'UNAUTHENTICATED',
        severity: 'error',
        title: 'Session expired',
        message: 'Your session is no longer valid. Please sign in again to continue.',
        clearForm: false,
        requiresReauth: true,
        isRateLimit: false,
        canRetry: false,
      };
    case 429:
      return {
        kind: 'RATE_LIMITED',
        severity: 'warning',
        title: 'Too many requests',
        message: 'You have made too many requests. Please wait a moment before trying again.',
        clearForm: false,
        requiresReauth: false,
        isRateLimit: true,
        canRetry: true,
      };
    case 504:
      return presentGenericError('TIMEOUT');
    case 502:
      // The BFF uses 502 for both NETWORK and UNEXPECTED; distinguish by the
      // forwarded `error` code so the message is as specific as possible, while
      // both remain generic retryable errors.
      return presentGenericError(input.error === 'NETWORK' ? 'NETWORK' : 'UNEXPECTED');
    default:
      return presentGenericError('UNEXPECTED');
  }
}

/**
 * Convenience adapter that maps a client-side {@link TransferResult} value to a
 * {@link TransferPresentation} by projecting it onto the same status/error
 * shape {@link mapTransferOutcome} consumes. This keeps a single source of
 * truth for the presentation copy whether the caller holds a parsed HTTP
 * outcome or a `TransferResult` union value.
 *
 * The transport-only reasons (NETWORK/TIMEOUT/UNEXPECTED) carry no HTTP status,
 * so they are projected onto the same 504/502 the BFF would have used, which
 * routes them to the generic error presentation.
 */
export function mapTransferResult(result: TransferResult): TransferPresentation {
  switch (result.kind) {
    case 'COMPLETED':
      return mapTransferOutcome({ status: 201, error: 'COMPLETED' });
    case 'AML_HELD':
      return mapTransferOutcome({ status: 202, error: 'AML_HELD' });
    case 'AML_BLOCKED':
      return mapTransferOutcome({ status: 422, error: 'AML_BLOCKED' });
    case 'CONFLICT':
      return mapTransferOutcome({ status: 409, error: result.error, message: result.message });
    case 'FORBIDDEN':
      return mapTransferOutcome({ status: 403, error: 'FORBIDDEN' });
    case 'UNAUTHENTICATED':
      return mapTransferOutcome({ status: 401, error: 'UNAUTHENTICATED' });
    case 'RATE_LIMITED':
      return mapTransferOutcome({ status: 429, error: 'RATE_LIMITED' });
    case 'ERROR':
      switch (result.reason) {
        case 'TIMEOUT':
          return mapTransferOutcome({ status: 504, error: 'TIMEOUT' });
        case 'NETWORK':
          return mapTransferOutcome({ status: 502, error: 'NETWORK' });
        case 'UNEXPECTED':
        default:
          return mapTransferOutcome({ status: 502, error: 'UNEXPECTED' });
      }
    default:
      // Exhaustiveness guard: an unknown kind maps to the generic error.
      return presentGenericError('UNEXPECTED');
  }
}
