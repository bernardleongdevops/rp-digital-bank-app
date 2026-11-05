'use client';

/**
 * Payee_Picker + payee management surface (task 8.1, Requirement 5).
 *
 * Rendered alongside the Transfer_Form (inside `TransferContainer`) so a
 * customer can reuse a Saved_Payee instead of retyping a destination account.
 * It owns three concerns, all talking to same-origin `/api/bff/payees` only
 * (never the gateway directly, Property 9):
 *
 *   1. LIST + SELECT (Requirements 5.4, 5.5, 5.6 / Property 10) — fetches
 *      `GET /api/bff/payees`, renders each payee's label + destination account,
 *      and invokes `onSelectPayee(destinationAccount)` when one is chosen so
 *      the parent can populate the Transfer_Form "To account" field. The pick
 *      sets the field to EXACTLY the payee's `destinationAccount`.
 *
 *   2. CREATE (Requirements 5.1, 5.2, 5.3, 5.13) — a small create form that
 *      runs the shared pure `validatePayeeForm` BEFORE any request; an empty
 *      label or empty destination account surfaces a field-level error and NO
 *      request is sent. A valid submit POSTs `{ label, destinationAccount }` to
 *      `/api/bff/payees`; on success the list is re-fetched so the new payee
 *      becomes available (5.3) and the create form is cleared.
 *
 *   3. DELETE (Requirement 5.7) — a per-payee delete control that calls
 *      `DELETE /api/bff/payees/[payeeId]`; on success the payee is removed from
 *      the list (the list is re-fetched so the picker reflects the source of
 *      truth).
 *
 * State machine (reuses the shared LoadingState / EmptyState / ErrorState and
 * follows the canonical per-region pattern):
 *   - loading — shown from first paint, well within 300 ms (Requirement 5.9);
 *   - empty   — a successful empty list shows "no saved payees" (Requirement 5.8);
 *   - error   — a timeout / network / other error status shows a retry that
 *               re-initiates the list request and RETAINS any entered create
 *               values (Requirement 5.10);
 *   - reauth  — a 401 routes to re-authentication ONCE per mount (Requirement 5.11);
 *   - ratelimit — a 429 shows a rate-limit message with retry disabled, no auto
 *               retry before >= 60 s (Requirement 5.12).
 *
 * The create/delete mutations reuse the same status handling so a 401 on a
 * mutation also routes to re-auth and a 429 surfaces the rate-limit message.
 *
 * Client/server validation parity: the create form uses the exact same pure
 * `validatePayeeForm` that the `POST /api/bff/payees` route re-applies
 * server-side (Requirement 5.13, Property 3).
 *
 * No secrets, no gateway URLs, no server-only imports.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import type { Payee } from '@/lib/types';
import { LoadingState } from '@/app/components/LoadingState';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import {
  validatePayeeForm,
  type PayeeFormErrors,
  type PayeeFormValues,
} from '@/lib/transferValidation';

/**
 * Loading lifecycle for the saved-payees list. `ready` carries the list (which
 * may be empty — the empty state is derived from `payees.length === 0`), while
 * `reauth` and `ratelimit` are distinct terminal states that drive a
 * re-authentication redirect and a rate-limit message respectively.
 */
type PayeesState =
  | { status: 'loading' }
  | { status: 'ready'; payees: Payee[] }
  | { status: 'error' }
  | { status: 'ratelimit' }
  | { status: 'reauth' };

const EMPTY_CREATE_VALUES: PayeeFormValues = {
  label: '',
  destinationAccount: '',
};

export interface PayeePickerProps {
  /**
   * Invoked with a Saved_Payee's destination account when the customer selects
   * it, so the parent can populate the Transfer_Form "To account" field with
   * exactly that value (Requirements 5.5, 5.6 / Property 10).
   */
  onSelectPayee: (destinationAccount: string) => void;
}

export function PayeePicker({ onSelectPayee }: PayeePickerProps) {
  const [state, setState] = useState<PayeesState>({ status: 'loading' });

  // Create-form state. The entered values are RETAINED across a failed list
  // load / create (Requirement 5.10) because they live independently of the
  // list state machine.
  const [createValues, setCreateValues] = useState<PayeeFormValues>(EMPTY_CREATE_VALUES);
  const [createErrors, setCreateErrors] = useState<PayeeFormErrors>({});
  const [createAttempted, setCreateAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  // Per-payee in-flight delete marker (the id currently being deleted) so the
  // relevant control can disable itself and announce progress.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Guards a single re-auth redirect per mount so repeated 401s don't trigger
  // multiple navigations (Requirement 5.11).
  const reauthTriggered = useRef(false);

  /** Route to re-authentication once per mount for a 401 outcome. */
  const routeToReauth = useCallback(() => {
    if (reauthTriggered.current) return;
    reauthTriggered.current = true;
    setState({ status: 'reauth' });
    void signIn('keycloak', { callbackUrl: '/transfer' });
  }, []);

  /**
   * Load the saved payees from the BFF (same-origin). Extracted so the error
   * state's retry and the post-create/delete refresh can re-run it. A 401
   * routes to re-auth; a 429 shows the rate-limit state; any other failure
   * shows the generic retryable error.
   */
  const loadPayees = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await fetch('/api/bff/payees', {
        headers: { Accept: 'application/json' },
      });

      if (res.status === 401) {
        routeToReauth();
        return;
      }
      if (res.status === 429) {
        setState({ status: 'ratelimit' });
        return;
      }
      if (!res.ok) {
        setState({ status: 'error' });
        return;
      }

      const data = (await res.json()) as Payee[];
      setState({ status: 'ready', payees: Array.isArray(data) ? data : [] });
    } catch {
      setState({ status: 'error' });
    }
  }, [routeToReauth]);

  useEffect(() => {
    void loadPayees();
  }, [loadPayees]);

  /** Update one create-form field, re-validating live after the first attempt. */
  const setCreateField = useCallback(
    <K extends keyof PayeeFormValues>(field: K, value: PayeeFormValues[K]) => {
      setCreateValues((prev) => {
        const next = { ...prev, [field]: value };
        if (createAttempted) {
          setCreateErrors(validatePayeeForm(next));
        }
        return next;
      });
    },
    [createAttempted],
  );

  /**
   * Handle a create-payee submit: validate with the shared pure rules first and
   * block the request on any violation (Requirement 5.2); on a valid submit
   * POST to the BFF and, on success, refresh the list and clear the form (5.3).
   */
  const handleCreate = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreateAttempted(true);
      setCreateFailed(false);

      const nextErrors = validatePayeeForm(createValues);
      setCreateErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;

      setCreating(true);
      try {
        const res = await fetch('/api/bff/payees', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            label: createValues.label.trim(),
            destinationAccount: createValues.destinationAccount.trim(),
          }),
        });

        if (res.status === 401) {
          routeToReauth();
          return;
        }
        if (res.status === 429) {
          setState({ status: 'ratelimit' });
          return;
        }
        if (!res.ok) {
          // Retain the entered values so the customer can retry (5.10).
          setCreateFailed(true);
          return;
        }

        // Success: make the new payee available on the next read (5.3) and
        // reset the create form.
        setCreateValues(EMPTY_CREATE_VALUES);
        setCreateErrors({});
        setCreateAttempted(false);
        await loadPayees();
      } catch {
        setCreateFailed(true);
      } finally {
        setCreating(false);
      }
    },
    [createValues, loadPayees, routeToReauth],
  );

  /**
   * Delete a saved payee via the BFF; on success remove it from the picker by
   * re-fetching the list (Requirement 5.7).
   */
  const handleDelete = useCallback(
    async (payeeId: string) => {
      setDeletingId(payeeId);
      try {
        const res = await fetch(`/api/bff/payees/${encodeURIComponent(payeeId)}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        });

        if (res.status === 401) {
          routeToReauth();
          return;
        }
        if (res.status === 429) {
          setState({ status: 'ratelimit' });
          return;
        }
        if (!res.ok) {
          setState({ status: 'error' });
          return;
        }

        await loadPayees();
      } catch {
        setState({ status: 'error' });
      } finally {
        setDeletingId(null);
      }
    },
    [loadPayees, routeToReauth],
  );

  return (
    <section aria-label="Saved payees">
      <h2>Saved payees</h2>

      {/* --- List / select region (5.4-5.9) --- */}
      {state.status === 'loading' ? (
        <LoadingState label="Loading your saved payees…" />
      ) : state.status === 'reauth' ? (
        <LoadingState label="Redirecting to sign in…" />
      ) : state.status === 'ratelimit' ? (
        <ErrorState
          message="Too many requests. Please wait a moment before trying again."
          onRetry={() => void loadPayees()}
          canRetry={false}
          retryLabel="Retry"
        />
      ) : state.status === 'error' ? (
        <ErrorState
          message="We couldn't load your saved payees. Please try again."
          onRetry={() => void loadPayees()}
        />
      ) : state.payees.length === 0 ? (
        <EmptyState
          title="No saved payees"
          description="You have no saved payees yet. Add one below to reuse it on a transfer."
        />
      ) : (
        <ul aria-label="Saved payee list">
          {state.payees.map((payee) => (
            <li key={payee.id}>
              <button
                type="button"
                onClick={() => onSelectPayee(payee.destinationAccount)}
                aria-label={`Use ${payee.label} (${payee.destinationAccount}) as the destination account`}
              >
                <span>{payee.label}</span>
                <span> · </span>
                <span>{payee.destinationAccount}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(payee.id)}
                disabled={deletingId === payee.id}
                aria-label={`Delete payee ${payee.label}`}
              >
                {deletingId === payee.id ? 'Deleting…' : 'Delete'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* --- Create region (5.1-5.3) --- */}
      <form onSubmit={handleCreate} noValidate aria-label="Add a saved payee">
        <div>
          <label htmlFor="payee-label">Payee label</label>
          <input
            id="payee-label"
            name="label"
            type="text"
            autoComplete="off"
            value={createValues.label}
            onChange={(e) => setCreateField('label', e.target.value)}
            disabled={creating}
            aria-invalid={createErrors.label ? true : undefined}
            aria-describedby={createErrors.label ? 'payee-label-error' : undefined}
          />
          {createErrors.label ? (
            <p id="payee-label-error" role="alert">
              {createErrors.label}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="payee-destination">Destination account</label>
          <input
            id="payee-destination"
            name="destinationAccount"
            type="text"
            autoComplete="off"
            value={createValues.destinationAccount}
            onChange={(e) => setCreateField('destinationAccount', e.target.value)}
            disabled={creating}
            aria-invalid={createErrors.destinationAccount ? true : undefined}
            aria-describedby={
              createErrors.destinationAccount ? 'payee-destination-error' : undefined
            }
          />
          {createErrors.destinationAccount ? (
            <p id="payee-destination-error" role="alert">
              {createErrors.destinationAccount}
            </p>
          ) : null}
        </div>

        {createFailed ? (
          <p role="alert">We couldn&apos;t save that payee. Please try again.</p>
        ) : null}

        <button type="submit" disabled={creating}>
          {creating ? 'Saving…' : 'Add payee'}
        </button>
      </form>
    </section>
  );
}
