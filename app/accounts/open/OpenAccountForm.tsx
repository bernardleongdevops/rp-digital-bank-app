'use client';

/**
 * Open-account form client component (task 6.1, Requirement 3).
 *
 * Renders the open-account form with an Account `type` select (SAVINGS |
 * CURRENT) and a `currency` field, performs FULL client-side validation BEFORE
 * any request is sent (Requirement 3.2), submits a valid request to the
 * same-origin BFF (`POST /api/bff/accounts`), and renders the mutation outcome.
 *
 * It mirrors the canonical form + submit-lifecycle pattern of the Transfer
 * feature (`TransferForm` + `TransferContainer`), but is a single, self-contained
 * component because the open-account form is small: it owns the field state, the
 * client validation, the in-flight submit guard, the `POST`, and the outcome
 * rendering together.
 *
 * Validation (Requirement 3.2): a missing or unsupported Account type, or a
 * missing (empty/whitespace) currency, produces a field-level error and the
 * request is NOT sent. These rules mirror the server-side defence-in-depth in
 * `app/api/bff/accounts/route.ts` so the client rejects exactly what the BFF
 * would reject.
 *
 * Submit lifecycle:
 *   - A synchronous in-flight guard (`SubmitGuard`) ensures a repeated submit
 *     while a request is in flight issues at most one outbound `POST`, immune to
 *     React batching (analogous to the Transfer_Form submit guard). The
 *     `submitting` state additionally disables the fields/button so the control
 *     is visibly disabled while in flight.
 *   - On a completed request the response `{ status, error?, message? }` is fed
 *     to the pure, total `mapMutationOutcome` mapper to decide the outcome state:
 *       201        -> success outcome (Requirement 3.3); the form is cleared.
 *       403        -> not-authorized state (Requirement 3.8).
 *       401        -> route to re-authentication via `signIn` (Requirement 3.10).
 *       429        -> rate-limit message, no auto-retry (Requirement 3.11).
 *       timeout /
 *       network /
 *       any other  -> generic retryable error (Requirement 3.12).
 *
 * Accessibility: each field has an associated `<label>`; a field with an error
 * sets `aria-invalid` and `aria-describedby` pointing at an inline
 * `role="alert"` message. The outcome region is rendered with `role="status"`
 * for a success outcome and `role="alert"` for an error/warning outcome,
 * consistent with `TransferResultBanner` conventions.
 *
 * Data discipline: all I/O targets the same-origin `/api/bff/accounts` only,
 * never the Sandbox_Gateway (Property 5 / Property 9).
 */

import { useCallback, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import type { AccountType, OpenAccountRequest } from '@/lib/types';
import {
  mapMutationOutcome,
  type MutationPresentation,
} from '@/lib/transferPresentation';
import { SubmitGuard } from '@/lib/transferSubmit';

/** The Account types the open-account form accepts (Requirement 3.2). */
const ACCEPTED_ACCOUNT_TYPES: readonly AccountType[] = ['SAVINGS', 'CURRENT'];

/** As-typed form values. `type` is kept as a free string so the "missing /
 * unsupported type" rule can be enforced client-side before narrowing. */
interface OpenAccountFormValues {
  type: string;
  currency: string;
}

/** Field-level validation errors, keyed by field name (Requirement 3.2). */
interface OpenAccountFormErrors {
  type?: string;
  currency?: string;
}

const EMPTY_VALUES: OpenAccountFormValues = { type: '', currency: '' };

/**
 * Pure client-side validation mirroring the BFF's `validateOpenAccountBody`:
 *   - `type` missing or not an accepted Account type -> field error.
 *   - `currency` missing / empty / whitespace-only    -> field error.
 * Returns an errors object; an empty object means the input is valid.
 */
function validateOpenAccountForm(values: OpenAccountFormValues): OpenAccountFormErrors {
  const errors: OpenAccountFormErrors = {};

  if (
    values.type.trim().length === 0 ||
    !ACCEPTED_ACCOUNT_TYPES.includes(values.type as AccountType)
  ) {
    errors.type = 'Select an account type.';
  }

  if (values.currency.trim().length === 0) {
    errors.currency = 'Enter a currency.';
  }

  return errors;
}

/** Convert validated values into the typed request body the BFF expects. */
function toOpenAccountRequest(values: OpenAccountFormValues): OpenAccountRequest {
  return {
    type: values.type as AccountType,
    currency: values.currency.trim(),
  };
}

/**
 * POST a validated open-account request to the BFF and parse the response into
 * the `{ status, error?, message? }` shape `mapMutationOutcome` consumes. A
 * thrown `fetch` is mapped to the BFF's own transport statuses (504 TIMEOUT /
 * 502 NETWORK) so a client-side failure routes to the generic retryable error.
 */
async function postOpenAccount(
  body: OpenAccountRequest,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ status: number; error?: string; message?: string }> {
  const doFetch = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch('/api/bff/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (e) {
    const isAbort = e instanceof DOMException && e.name === 'AbortError';
    return isAbort ? { status: 504, error: 'TIMEOUT' } : { status: 502, error: 'NETWORK' };
  }

  let error: string | undefined;
  let message: string | undefined;
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    if (data && typeof data.error === 'string') error = data.error;
    if (data && typeof data.message === 'string') message = data.message;
  } catch {
    // Empty / non-JSON body: the HTTP status alone drives the outcome.
  }

  return { status: res.status, error, message };
}

export interface OpenAccountFormProps {
  /**
   * Test/seam hook for the outbound POST. Production callers omit it and the
   * component uses the same-origin `fetch` to `/api/bff/accounts`.
   */
  fetchImpl?: typeof fetch;
}

export function OpenAccountForm({ fetchImpl }: OpenAccountFormProps) {
  const [values, setValues] = useState<OpenAccountFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<OpenAccountFormErrors>({});
  // After the first submit attempt, re-validate live on edit so the customer
  // sees errors clear as they fix them.
  const [attempted, setAttempted] = useState(false);

  // In-flight guard: the single synchronous source of truth for "a request is
  // in flight", immune to React batching so a double submit issues one POST.
  const guardRef = useRef<SubmitGuard>(new SubmitGuard());
  const [submitting, setSubmitting] = useState(false);

  // The presentation for the latest completed request, or null before the
  // first outcome. Drives the outcome region.
  const [presentation, setPresentation] = useState<MutationPresentation | null>(null);

  const setField = useCallback(
    <K extends keyof OpenAccountFormValues>(field: K, value: OpenAccountFormValues[K]) => {
      setValues((prev) => {
        const next = { ...prev, [field]: value };
        if (attempted) setErrors(validateOpenAccountForm(next));
        return next;
      });
    },
    [attempted],
  );

  /** Run one open-account request cycle, guarded to one in-flight POST. */
  const runOpenAccount = useCallback(
    async (body: OpenAccountRequest) => {
      if (!guardRef.current.begin()) return;

      setSubmitting(true);
      // Clear any prior outcome so a retry does not briefly show a stale banner.
      setPresentation(null);

      try {
        const outcome = await postOpenAccount(body, { fetchImpl });
        const next = mapMutationOutcome(outcome);

        // 401 -> route to re-authentication rather than rendering a banner
        // (Requirement 3.10).
        if (next.requiresReauth) {
          void signIn('keycloak', { callbackUrl: '/accounts/open' });
          return;
        }

        setPresentation(next);

        // On success, clear the form so the fields are ready for the next
        // account (Requirement 3.3).
        if (next.isSuccess) {
          setValues(EMPTY_VALUES);
          setErrors({});
          setAttempted(false);
        }
      } finally {
        guardRef.current.end();
        setSubmitting(false);
      }
    },
    [fetchImpl],
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setAttempted(true);

      const nextErrors = validateOpenAccountForm(values);
      setErrors(nextErrors);

      // Any violation: show field-level errors and DO NOT send the request
      // (Requirement 3.2).
      if (Object.keys(nextErrors).length > 0) return;

      void runOpenAccount(toOpenAccountRequest(values));
    },
    [values, runOpenAccount],
  );

  /** Retry seam for the generic-error outcome: re-send the current values. */
  const handleRetry = useCallback(() => {
    const nextErrors = validateOpenAccountForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void runOpenAccount(toOpenAccountRequest(values));
  }, [values, runOpenAccount]);

  const isError = presentation
    ? presentation.severity === 'error' || presentation.severity === 'warning'
    : false;
  const showRetry = presentation ? presentation.canRetry && !presentation.isRateLimit : false;

  return (
    <div>
      <form onSubmit={handleSubmit} noValidate aria-label="Open an account">
        {/* Account type — SAVINGS | CURRENT. */}
        <div>
          <label htmlFor="open-account-type">Account type</label>
          <select
            id="open-account-type"
            name="type"
            value={values.type}
            onChange={(e) => setField('type', e.target.value)}
            disabled={submitting}
            aria-invalid={errors.type ? true : undefined}
            aria-describedby={errors.type ? 'open-account-type-error' : undefined}
          >
            <option value="">Select an account type</option>
            {ACCEPTED_ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          {errors.type ? (
            <p id="open-account-type-error" role="alert">
              {errors.type}
            </p>
          ) : null}
        </div>

        {/* Currency — required, non-empty (e.g. SGD, USD). */}
        <div>
          <label htmlFor="open-account-currency">Currency</label>
          <input
            id="open-account-currency"
            name="currency"
            type="text"
            inputMode="text"
            autoComplete="off"
            value={values.currency}
            onChange={(e) => setField('currency', e.target.value)}
            disabled={submitting}
            aria-invalid={errors.currency ? true : undefined}
            aria-describedby={errors.currency ? 'open-account-currency-error' : undefined}
          />
          {errors.currency ? (
            <p id="open-account-currency-error" role="alert">
              {errors.currency}
            </p>
          ) : null}
        </div>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Opening…' : 'Open account'}
        </button>
      </form>

      {presentation ? (
        <div
          role={isError ? 'alert' : 'status'}
          aria-live={isError ? 'assertive' : 'polite'}
          data-outcome={presentation.kind}
        >
          <p>
            <strong>{presentation.title}</strong>
          </p>
          <p>{presentation.message}</p>
          {showRetry ? (
            <button type="button" onClick={handleRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
