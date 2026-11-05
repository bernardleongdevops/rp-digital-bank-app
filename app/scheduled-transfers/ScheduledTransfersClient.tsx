'use client';

/**
 * Scheduled_Transfer views client component (task 9.1, Requirement 6).
 *
 * Owns the three Scheduled_Transfer surfaces that live on `/scheduled-transfers`:
 *
 *   CREATE (Requirements 6.1-6.4)
 *     A form with source account, destination account, amount, description,
 *     schedule date, and recurrence. The source account is chosen from the
 *     customer's own accounts (fetched from `GET /api/bff/accounts`) so the
 *     "source must be owned" rule can be enforced client-side, mirroring the
 *     Transfer_Form. FULL client-side validation runs BEFORE any request is
 *     sent via the shared, pure `validateScheduledTransferForm(values, now,
 *     ownedAccounts?)` — invalid input produces field-level errors and NO
 *     request (6.2), and a schedule date not strictly after the current date is
 *     a field error (6.3). A valid submit POSTs a `ScheduledTransferRequest`
 *     (amount coerced to a number) to `POST /api/bff/scheduled-transfers`
 *     behind a single-flight `SubmitGuard`; the `{ status, error?, message? }`
 *     response is mapped through the shared, total `mapMutationOutcome`
 *     (201 success / 403 / 401 re-auth / 429 / 409 / generic — 6.4 and the
 *     mutation table). A successful create refreshes the list.
 *
 *   LIST (Requirements 6.5, 6.8-6.11, 6.13)
 *     Fetches `GET /api/bff/scheduled-transfers` into the canonical per-region
 *     `RegionState` machine: a loading state from first paint (satisfying the
 *     300 ms bound), an empty state when the list is empty, an error state with
 *     retry on failure/timeout, a single re-auth on 401, and a rate-limit
 *     message with retry disabled on 429. Each transfer renders with its
 *     Scheduled_Transfer_Status.
 *
 *   CANCEL (Requirements 6.6, 6.12)
 *     For items whose status is SCHEDULED, a cancel control POSTs
 *     `/api/bff/scheduled-transfers/[id]/cancel`. On success the item is shown
 *     as cancelled (the list is re-fetched); a 409 (already executed/cancelled)
 *     surfaces a distinct conflict message via `mapMutationOutcome`.
 *
 *   EXECUTED OUTCOME (Requirement 6.7, Property 5)
 *     For a transfer that has executed (status EXECUTED/FAILED carrying a
 *     `lastOutcome`), the outcome is rendered with `mapTransferOutcome(
 *     lastOutcome)` fed into the shared `TransferResultBanner` so the AML
 *     held/blocked outcomes render IDENTICALLY to the Transfer_Form — a single
 *     outcome-mapping source of truth.
 *
 * Data discipline (Property 5 / Property 9): every browser fetch targets the
 * same-origin `/api/bff/*` only, as an inline string/template literal, never
 * the Sandbox_Gateway directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import type {
  Account,
  Recurrence,
  ScheduledTransfer,
} from '@/lib/types';
import { formatCurrency } from '@/lib/currency';
import { LoadingState } from '@/app/components/LoadingState';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { TransferResultBanner } from '@/app/components/TransferResultBanner';
import {
  mapMutationOutcome,
  mapTransferOutcome,
  type MutationPresentation,
} from '@/lib/transferPresentation';
import { SubmitGuard } from '@/lib/transferSubmit';
import {
  MAX_DESCRIPTION_LENGTH,
  RECURRENCE_VALUES,
  validateScheduledTransferForm,
  type ScheduledTransferFormErrors,
  type ScheduledTransferFormValues,
} from '@/lib/transferValidation';

/** Read-call timeout so a hung BFF/gateway surfaces as an error, not a spinner forever. */
const READ_TIMEOUT_MS = 10_000;

/** Default recurrence for a fresh form: a one-off scheduled transfer. */
const DEFAULT_RECURRENCE: Recurrence = 'ONCE';

const EMPTY_VALUES: ScheduledTransferFormValues = {
  fromAccount: '',
  toAccount: '',
  amount: '',
  description: '',
  scheduleDate: '',
  recurrence: DEFAULT_RECURRENCE,
};

/** Human-readable labels for each recurrence option. */
const RECURRENCE_LABELS: Record<Recurrence, string> = {
  ONCE: 'One-off',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
};

// ===========================================================================
// Per-region state machine for the list (mirrors DashboardClient).
// ===========================================================================

type RegionStatus = 'loading' | 'ok' | 'error';

interface RegionError {
  /** Safe, user-facing message. Never carries raw upstream detail or secrets. */
  message: string;
  /** False only for rate-limiting (429): retry must wait a short delay. */
  canRetry: boolean;
}

interface RegionState<T> {
  status: RegionStatus;
  data?: T;
  error?: RegionError;
}

const INITIAL_LIST: RegionState<ScheduledTransfer[]> = { status: 'loading' };

/**
 * A fetch failure that should route the customer to re-authentication rather
 * than render an inline error (BFF returned 401).
 */
class ReauthRequired extends Error {}

/**
 * Fetch a same-origin BFF read endpoint and return its parsed JSON body.
 * `401` -> throw {@link ReauthRequired}; `429` -> a rate-limit error; any other
 * non-2xx / timeout / network -> a safe, user-facing error.
 */
async function fetchBffJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    throw new Error(
      aborted
        ? 'This is taking longer than expected. Please try again.'
        : 'We could not reach the service. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new ReauthRequired();
  if (res.status === 429) {
    const rl = new Error('Too many requests. Please wait a moment before trying again.');
    rl.name = 'RateLimited';
    throw rl;
  }
  if (!res.ok) {
    throw new Error('Something went wrong loading this section. Please try again.');
  }
  return (await res.json()) as T;
}

/** Map a thrown fetch error to the safe per-region error shape. */
function toRegionError(e: unknown): RegionError {
  if (e instanceof Error && e.name === 'RateLimited') {
    return { message: e.message, canRetry: false };
  }
  if (e instanceof Error) {
    return { message: e.message, canRetry: true };
  }
  return { message: 'Something went wrong. Please try again.', canRetry: true };
}

/**
 * POST to a same-origin BFF mutation endpoint and parse the response into the
 * `{ status, error?, message? }` shape `mapMutationOutcome` consumes. A thrown
 * `fetch` is mapped to the BFF's own transport statuses (504 TIMEOUT / 502
 * NETWORK) so a client-side failure routes to the generic retryable error.
 */
async function postBff(
  path: string,
  body: unknown,
): Promise<{ status: number; error?: string; message?: string }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
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

/** True when a scheduled transfer has executed and carries an outcome (6.7). */
function hasExecutedOutcome(transfer: ScheduledTransfer): boolean {
  return (
    transfer.lastOutcome !== undefined &&
    (transfer.status === 'EXECUTED' || transfer.status === 'FAILED')
  );
}

export function ScheduledTransfersClient() {
  // The customer's own accounts, used to populate the source selector and to
  // enforce the "source must be owned" validation rule.
  const [accountsState, setAccountsState] = useState<RegionState<Account[]>>({
    status: 'loading',
  });

  // The scheduled-transfer list region.
  const [list, setList] = useState<RegionState<ScheduledTransfer[]>>(INITIAL_LIST);

  // Create-form state.
  const [values, setValues] = useState<ScheduledTransferFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<ScheduledTransferFormErrors>({});
  const [attempted, setAttempted] = useState(false);

  // Create submit lifecycle (single-flight, immune to React batching).
  const createGuardRef = useRef<SubmitGuard>(new SubmitGuard());
  const [submitting, setSubmitting] = useState(false);
  const [createOutcome, setCreateOutcome] = useState<MutationPresentation | null>(null);

  // Cancel lifecycle: one in-flight cancel at a time, tracked per-id so the
  // right control shows a disabled/pending state; the latest cancel outcome is
  // surfaced as a banner.
  const cancelGuardRef = useRef<SubmitGuard>(new SubmitGuard());
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelOutcome, setCancelOutcome] = useState<MutationPresentation | null>(null);

  // Guard so a 401 triggers re-authentication AT MOST ONCE per mount.
  const reauthTriggered = useRef(false);
  const triggerReauthOnce = useCallback(() => {
    if (reauthTriggered.current) return;
    reauthTriggered.current = true;
    void signIn('keycloak', { callbackUrl: '/scheduled-transfers' });
  }, []);

  /** Load the customer's owned accounts (for the source selector). */
  const loadAccounts = useCallback(async () => {
    setAccountsState((prev) => ({ status: 'loading', data: prev.data }));
    try {
      const data = await fetchBffJson<Account[]>('/api/bff/accounts');
      setAccountsState({ status: 'ok', data: Array.isArray(data) ? data : [] });
    } catch (e) {
      if (e instanceof ReauthRequired) {
        triggerReauthOnce();
        return;
      }
      setAccountsState((prev) => ({
        status: 'error',
        data: prev.data,
        error: toRegionError(e),
      }));
    }
  }, [triggerReauthOnce]);

  /** Load the scheduled-transfer list (Requirements 6.5, 6.8-6.11, 6.13). */
  const loadList = useCallback(async () => {
    setList((prev) => ({ status: 'loading', data: prev.data }));
    try {
      const data = await fetchBffJson<ScheduledTransfer[]>('/api/bff/scheduled-transfers');
      setList({ status: 'ok', data: Array.isArray(data) ? data : [] });
    } catch (e) {
      if (e instanceof ReauthRequired) {
        triggerReauthOnce();
        return;
      }
      setList((prev) => ({ status: 'error', data: prev.data, error: toRegionError(e) }));
    }
  }, [triggerReauthOnce]);

  useEffect(() => {
    void loadAccounts();
    void loadList();
  }, [loadAccounts, loadList]);

  const ownedAccounts =
    accountsState.status === 'ok' ? accountsState.data : undefined;

  /** Update one field, re-validating live once a submit has been attempted. */
  const setField = useCallback(
    <K extends keyof ScheduledTransferFormValues>(
      field: K,
      value: ScheduledTransferFormValues[K],
    ) => {
      setValues((prev) => {
        const next = { ...prev, [field]: value };
        if (attempted) {
          setErrors(validateScheduledTransferForm(next, new Date(), ownedAccounts));
        }
        return next;
      });
    },
    [attempted, ownedAccounts],
  );

  /** Run one create request cycle, guarded to a single in-flight POST. */
  const runCreate = useCallback(
    async (formValues: ScheduledTransferFormValues) => {
      if (!createGuardRef.current.begin()) return;

      setSubmitting(true);
      setCreateOutcome(null);

      try {
        const outcome = await postBff('/api/bff/scheduled-transfers', {
          fromAccount: formValues.fromAccount.trim(),
          toAccount: formValues.toAccount.trim(),
          amount: Number(formValues.amount.trim()),
          description: formValues.description,
          scheduleDate: formValues.scheduleDate.trim(),
          recurrence: formValues.recurrence,
        });
        const next = mapMutationOutcome(outcome);

        // 401 -> route to re-authentication rather than rendering a banner.
        if (next.requiresReauth) {
          triggerReauthOnce();
          return;
        }

        setCreateOutcome(next);

        // On success, clear the form and refresh the list so the new transfer
        // appears on its next data request (Requirement 6.4).
        if (next.isSuccess) {
          setValues(EMPTY_VALUES);
          setErrors({});
          setAttempted(false);
          void loadList();
        }
      } finally {
        createGuardRef.current.end();
        setSubmitting(false);
      }
    },
    [triggerReauthOnce, loadList],
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setAttempted(true);

      const nextErrors = validateScheduledTransferForm(values, new Date(), ownedAccounts);
      setErrors(nextErrors);

      // Any violation: show field-level errors and DO NOT send the request
      // (Requirements 6.2, 6.3).
      if (Object.keys(nextErrors).length > 0) return;

      void runCreate(values);
    },
    [values, ownedAccounts, runCreate],
  );

  /** Retry seam for the generic create-error outcome: re-send current values. */
  const handleCreateRetry = useCallback(() => {
    const nextErrors = validateScheduledTransferForm(values, new Date(), ownedAccounts);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void runCreate(values);
  }, [values, ownedAccounts, runCreate]);

  /** Cancel a SCHEDULED transfer (Requirements 6.6, 6.12). */
  const runCancel = useCallback(
    async (id: string) => {
      if (!cancelGuardRef.current.begin()) return;

      setCancellingId(id);
      setCancelOutcome(null);

      try {
        const outcome = await postBff(
          `/api/bff/scheduled-transfers/${encodeURIComponent(id)}/cancel`,
          {},
        );
        const next = mapMutationOutcome(outcome);

        if (next.requiresReauth) {
          triggerReauthOnce();
          return;
        }

        setCancelOutcome(next);

        // On success, re-fetch the list so the item reflects its cancelled
        // status (Requirement 6.6).
        if (next.isSuccess) {
          void loadList();
        }
      } finally {
        cancelGuardRef.current.end();
        setCancellingId(null);
      }
    },
    [triggerReauthOnce, loadList],
  );

  const descriptionLength = values.description.length;
  const createIsError = createOutcome
    ? createOutcome.severity === 'error' || createOutcome.severity === 'warning'
    : false;
  const createShowRetry = createOutcome
    ? createOutcome.canRetry && !createOutcome.isRateLimit
    : false;

  return (
    <div>
      {/* ============================ CREATE ============================ */}
      <section aria-labelledby="schedule-create-heading">
        <h2 id="schedule-create-heading">Schedule a transfer</h2>
        <form onSubmit={handleSubmit} noValidate aria-label="Schedule a transfer">
          {/* Source account — chosen from the customer's own accounts. */}
          <div>
            <label htmlFor="schedule-from">From account</label>
            {accountsState.status === 'loading' ? (
              <LoadingState label="Loading your accounts…" />
            ) : accountsState.status === 'error' ? (
              <ErrorState
                message="We couldn't load your accounts. Please try again."
                canRetry={accountsState.error?.canRetry ?? true}
                onRetry={() => void loadAccounts()}
              />
            ) : accountsState.data && accountsState.data.length === 0 ? (
              <p role="status">You have no accounts available to transfer from.</p>
            ) : (
              <select
                id="schedule-from"
                name="fromAccount"
                value={values.fromAccount}
                onChange={(e) => setField('fromAccount', e.target.value)}
                disabled={submitting}
                aria-invalid={errors.fromAccount ? true : undefined}
                aria-describedby={errors.fromAccount ? 'schedule-from-error' : undefined}
              >
                <option value="">Select a source account</option>
                {accountsState.data?.map((account) => (
                  <option key={account.accountNumber} value={account.accountNumber}>
                    {account.accountNumber} · {account.type} ·{' '}
                    {formatCurrency(account.balance, account.currency)}
                  </option>
                ))}
              </select>
            )}
            {errors.fromAccount ? (
              <p id="schedule-from-error" role="alert">
                {errors.fromAccount}
              </p>
            ) : null}
          </div>

          {/* Destination account — free-text entry. */}
          <div>
            <label htmlFor="schedule-to">To account</label>
            <input
              id="schedule-to"
              name="toAccount"
              type="text"
              inputMode="text"
              autoComplete="off"
              value={values.toAccount}
              onChange={(e) => setField('toAccount', e.target.value)}
              disabled={submitting}
              aria-invalid={errors.toAccount ? true : undefined}
              aria-describedby={errors.toAccount ? 'schedule-to-error' : undefined}
            />
            {errors.toAccount ? (
              <p id="schedule-to-error" role="alert">
                {errors.toAccount}
              </p>
            ) : null}
          </div>

          {/* Amount — validated as typed text (numeric, > 0, in range, <=2 dp). */}
          <div>
            <label htmlFor="schedule-amount">Amount</label>
            <input
              id="schedule-amount"
              name="amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={values.amount}
              onChange={(e) => setField('amount', e.target.value)}
              disabled={submitting}
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby={errors.amount ? 'schedule-amount-error' : undefined}
            />
            {errors.amount ? (
              <p id="schedule-amount-error" role="alert">
                {errors.amount}
              </p>
            ) : null}
          </div>

          {/* Description — optional, 0..140 chars. */}
          <div>
            <label htmlFor="schedule-description">Description (optional)</label>
            <textarea
              id="schedule-description"
              name="description"
              value={values.description}
              onChange={(e) => setField('description', e.target.value)}
              disabled={submitting}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={
                errors.description
                  ? 'schedule-description-error'
                  : 'schedule-description-hint'
              }
            />
            <p id="schedule-description-hint">
              {descriptionLength}/{MAX_DESCRIPTION_LENGTH}
            </p>
            {errors.description ? (
              <p id="schedule-description-error" role="alert">
                {errors.description}
              </p>
            ) : null}
          </div>

          {/* Schedule date — must be strictly after today (Requirement 6.3). */}
          <div>
            <label htmlFor="schedule-date">Schedule date</label>
            <input
              id="schedule-date"
              name="scheduleDate"
              type="date"
              value={values.scheduleDate}
              onChange={(e) => setField('scheduleDate', e.target.value)}
              disabled={submitting}
              aria-invalid={errors.scheduleDate ? true : undefined}
              aria-describedby={errors.scheduleDate ? 'schedule-date-error' : undefined}
            />
            {errors.scheduleDate ? (
              <p id="schedule-date-error" role="alert">
                {errors.scheduleDate}
              </p>
            ) : null}
          </div>

          {/* Recurrence — ONCE | DAILY | WEEKLY | MONTHLY (Requirement 6.1). */}
          <div>
            <label htmlFor="schedule-recurrence">Recurrence</label>
            <select
              id="schedule-recurrence"
              name="recurrence"
              value={values.recurrence}
              onChange={(e) => setField('recurrence', e.target.value as Recurrence)}
              disabled={submitting}
              aria-invalid={errors.recurrence ? true : undefined}
              aria-describedby={errors.recurrence ? 'schedule-recurrence-error' : undefined}
            >
              {RECURRENCE_VALUES.map((recurrence) => (
                <option key={recurrence} value={recurrence}>
                  {RECURRENCE_LABELS[recurrence]}
                </option>
              ))}
            </select>
            {errors.recurrence ? (
              <p id="schedule-recurrence-error" role="alert">
                {errors.recurrence}
              </p>
            ) : null}
          </div>

          <button type="submit" disabled={submitting}>
            {submitting ? 'Scheduling…' : 'Schedule transfer'}
          </button>
        </form>

        {createOutcome ? (
          <div
            role={createIsError ? 'alert' : 'status'}
            aria-live={createIsError ? 'assertive' : 'polite'}
            data-outcome={createOutcome.kind}
          >
            <p>
              <strong>{createOutcome.title}</strong>
            </p>
            <p>{createOutcome.message}</p>
            {createShowRetry ? (
              <button type="button" onClick={handleCreateRetry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ============================= LIST ============================= */}
      <section
        aria-labelledby="schedule-list-heading"
        aria-busy={list.status === 'loading'}
      >
        <h2 id="schedule-list-heading">Your scheduled transfers</h2>

        {/* A cancel outcome (e.g. a 409 conflict) is surfaced above the list. */}
        {cancelOutcome ? (
          <div
            role={
              cancelOutcome.severity === 'error' || cancelOutcome.severity === 'warning'
                ? 'alert'
                : 'status'
            }
            aria-live={
              cancelOutcome.severity === 'error' || cancelOutcome.severity === 'warning'
                ? 'assertive'
                : 'polite'
            }
            data-outcome={cancelOutcome.kind}
            data-testid="cancel-outcome"
          >
            <p>
              <strong>{cancelOutcome.title}</strong>
            </p>
            <p>{cancelOutcome.message}</p>
          </div>
        ) : null}

        {list.status === 'loading' ? (
          <LoadingState label="Loading your scheduled transfers…" />
        ) : list.status === 'error' ? (
          <ErrorState
            message={list.error?.message}
            canRetry={list.error?.canRetry ?? true}
            onRetry={() => void loadList()}
            retryLabel="Retry loading scheduled transfers"
          />
        ) : list.data && list.data.length === 0 ? (
          <EmptyState
            title="No scheduled transfers"
            description="You do not have any scheduled transfers yet."
          />
        ) : list.data ? (
          <ul aria-label="Scheduled transfer list">
            {list.data.map((transfer) => (
              <li key={transfer.id} data-testid="scheduled-transfer-item">
                <div>
                  <span data-testid="scheduled-transfer-from">{transfer.fromAccount}</span>
                  <span>{' → '}</span>
                  <span data-testid="scheduled-transfer-to">{transfer.toAccount}</span>
                  <span>{' · '}</span>
                  <span data-testid="scheduled-transfer-amount">
                    {formatCurrency(transfer.amount, '')}
                  </span>
                  <span>{' · '}</span>
                  <span>{RECURRENCE_LABELS[transfer.recurrence] ?? transfer.recurrence}</span>
                  <span>{' · '}</span>
                  <span data-testid="scheduled-transfer-date">{transfer.scheduleDate}</span>
                  <span>{' · '}</span>
                  <span data-testid="scheduled-transfer-status">{transfer.status}</span>
                </div>

                {transfer.description ? <p>{transfer.description}</p> : null}

                {/* Executed outcome — reuse the Transfer_Form outcome mapping so
                    AML held/blocked render identically (Requirement 6.7 / P5). */}
                {hasExecutedOutcome(transfer) ? (
                  <TransferResultBanner
                    presentation={mapTransferOutcome(transfer.lastOutcome!)}
                  />
                ) : null}

                {/* Cancel control — only for SCHEDULED items (Requirement 6.6). */}
                {transfer.status === 'SCHEDULED' ? (
                  <button
                    type="button"
                    onClick={() => void runCancel(transfer.id)}
                    disabled={cancellingId !== null}
                    data-testid="scheduled-transfer-cancel"
                  >
                    {cancellingId === transfer.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
