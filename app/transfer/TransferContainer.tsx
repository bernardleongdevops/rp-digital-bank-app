'use client';

/**
 * Transfer submission container (task 9.2, Requirement 4).
 *
 * Owns everything the pure `TransferForm` (task 9.1) deliberately left to 9.2:
 * the submit lifecycle, the in-flight guard, the `POST /api/bff/transfers`
 * call, and rendering the outcome. It wires the form's `onValidSubmit` +
 * `submitting` seams and renders a result banner driven by the transfer
 * outcome mapper.
 *
 * Why drive the banner from `mapTransferOutcome` rather than the raw
 * `TransferResult`: the BFF already mirrors the upstream transfer semantics 1:1
 * onto the HTTP response `{ status, error?, message? }` (see
 * `app/api/bff/_lib/respond.ts`). Feeding that response straight into
 * `mapTransferOutcome` gives a single, total, deterministic presentation model
 * — `severity`, `title`, `message`, `clearForm`, `requiresReauth`,
 * `isRateLimit`, `canRetry` — so every outcome (201/202/422/409-by-error-code/
 * 403/401/429/504/502) renders distinctly (Requirements 4.3-4.10) without the
 * container re-deriving copy. The 409 `message`/`error` code drives the
 * conflict text (Requirement 4.6).
 *
 * In-flight guard (Requirement 4.2): a repeated submit while a request is in
 * flight must NOT issue a second POST. The guard lives in a ref
 * (`SubmitGuard`) so it is synchronous and immune to React batching — a
 * double-click that fires two `onValidSubmit` calls before a re-render still
 * only passes the guard once. The `submitting` state additionally disables the
 * form's fields/button so the control is visibly disabled while in flight.
 *
 * Outcome handling:
 *   - COMPLETED (201): success banner AND the form is cleared by remounting
 *     `TransferForm` with a new `key` (a clean reset that respects 9.1's API
 *     rather than reaching into the form's internal state). Every non-success
 *     outcome leaves the entered values intact so the customer can correct or
 *     retry (Requirement 4.10).
 *   - UNAUTHENTICATED (401): route to re-authentication via `signIn`
 *     (Requirement 4.8) instead of showing a terminal banner.
 *   - RATE_LIMITED (429): banner with no automatic retry (Requirement 4.9).
 *   - TIMEOUT/NETWORK/UNEXPECTED and any uncovered status: generic error banner
 *     with a retry action that re-submits the same values (Requirement 4.10).
 *
 * Data discipline: all I/O goes through `postTransfer`, which targets the
 * same-origin `/api/bff/transfers` only — never the gateway (Requirement 6.4).
 */

import { useCallback, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { TransferForm } from './TransferForm';
import { TransferResultBanner } from '@/app/components/TransferResultBanner';
import {
  mapTransferOutcome,
  type TransferPresentation,
} from '@/lib/transferPresentation';
import { postTransfer, SubmitGuard } from '@/lib/transferSubmit';
import type { TransferFormValues } from '@/lib/transferValidation';

export function TransferContainer() {
  // In-flight guard: the single source of truth for "a request is in flight".
  // Held in a ref so repeated submits are rejected synchronously, before any
  // re-render can flip `submitting` (Requirement 4.2).
  const guardRef = useRef<SubmitGuard>(new SubmitGuard());

  // Mirrors the guard into render state so the form disables its fields/button
  // while a request is in flight.
  const [submitting, setSubmitting] = useState(false);

  // The presentation for the latest completed request, or null before the
  // first outcome. Drives the result banner.
  const [presentation, setPresentation] = useState<TransferPresentation | null>(null);

  // The last validated values, retained so the generic-error retry can re-send
  // the identical request (Requirement 4.10).
  const [lastValues, setLastValues] = useState<TransferFormValues | null>(null);

  // Remount key for the form. Bumping it on a COMPLETED outcome unmounts and
  // remounts `TransferForm`, giving a clean field reset (Requirement 4.3) while
  // respecting the form's 9.1 public API (no reset prop needed).
  const [formKey, setFormKey] = useState(0);

  /**
   * Run one transfer request cycle for the given validated values. Guarded so
   * at most one outbound POST is in flight at a time; a call made while a
   * request is already in flight is ignored (Requirement 4.2).
   */
  const runTransfer = useCallback(async (values: TransferFormValues) => {
    // Reject the submit if a request is already in flight.
    if (!guardRef.current.begin()) return;

    setSubmitting(true);
    setLastValues(values);
    // Clear any prior outcome so a retry does not briefly show a stale banner.
    setPresentation(null);

    try {
      const outcome = await postTransfer(values);
      const next = mapTransferOutcome(outcome);

      // 401 -> route to re-authentication rather than rendering a banner
      // (Requirement 4.8). Re-auth navigates away; the guard is released in
      // `finally` so a returning customer can submit again.
      if (next.requiresReauth) {
        void signIn('keycloak', { callbackUrl: '/transfer' });
        return;
      }

      setPresentation(next);

      // Only a completed transfer clears the form (Requirements 4.3, 4.10);
      // every other outcome retains the entered values.
      if (next.clearForm) {
        setFormKey((k) => k + 1);
        setLastValues(null);
      }
    } finally {
      // Always release the guard and clear the in-flight flag so the next
      // request cycle may begin (Requirement 4.2).
      guardRef.current.end();
      setSubmitting(false);
    }
  }, []);

  /** Form seam: invoked with validated values only (9.1 guarantees validity). */
  const handleValidSubmit = useCallback(
    (values: TransferFormValues) => {
      void runTransfer(values);
    },
    [runTransfer],
  );

  /** Retry seam for the generic-error banner: re-send the last values. */
  const handleRetry = useCallback(() => {
    if (lastValues) void runTransfer(lastValues);
  }, [lastValues, runTransfer]);

  return (
    <div>
      <TransferForm
        key={formKey}
        onValidSubmit={handleValidSubmit}
        submitting={submitting}
      />

      {presentation ? (
        <TransferResultBanner presentation={presentation} onRetry={handleRetry} />
      ) : null}
    </div>
  );
}
