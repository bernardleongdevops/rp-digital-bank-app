'use client';

/**
 * Close-account control with an explicit confirmation gate (task 6.2,
 * Requirement 3.4-3.12).
 *
 * Renders a "Close account" button that, when activated, reveals an inline,
 * accessible confirm/cancel prompt. CRUCIALLY, NO request is sent to the BFF
 * until the customer explicitly confirms (Requirement 3.4): the first click
 * only reveals the prompt. Cancelling the prompt sends no request and leaves
 * the account unchanged (Requirement 3.7). This deliberately does NOT use
 * `window.confirm`; instead it renders an accessible confirmation region with
 * its own Confirm and Cancel buttons so the gate is testable and screen-reader
 * friendly.
 *
 * On confirm the component POSTs to the same-origin BFF route:
 *   POST /api/bff/accounts/{accountNumber}/close
 * It NEVER talks to the Sandbox_Gateway directly; the access token and
 * Sandbox_Key stay server-side in the BFF (Property 5 / Property 9). The fetch
 * first-arg is an inline template literal beginning with '/api/bff/' so the
 * static direct-gateway-call guard can confirm the target.
 *
 * Submit lifecycle (mirrors `OpenAccountForm`):
 *   - A synchronous in-flight guard (`SubmitGuard`) ensures a repeated confirm
 *     while a request is in flight issues at most one outbound POST, immune to
 *     React batching. The `submitting` state additionally disables the Confirm
 *     button while in flight.
 *   - The response `{ status, error?, message? }` is fed to the pure, total
 *     `mapMutationOutcome` mapper to decide the outcome state:
 *       201        -> success outcome; calls `onClosed?.()` (Requirement 3.6).
 *       403        -> not-authorized state (Requirement 3.8).
 *       409        -> conflict state whose message reflects the `error` code,
 *                     e.g. ACCOUNT_NOT_EMPTY / ACCOUNT_ALREADY_CLOSED
 *                     (Requirement 3.9).
 *       401        -> route to re-authentication via `signIn` (Requirement 3.10).
 *       429        -> rate-limit message, no auto-retry (Requirement 3.11).
 *       timeout /
 *       network /
 *       any other  -> generic retryable error (Requirement 3.12).
 *
 * Accessibility: the outcome region is rendered with `role="status"` for a
 * success outcome and `role="alert"` for an error/warning outcome, consistent
 * with `OpenAccountForm`/`TransferResultBanner` conventions.
 */

import { useCallback, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import {
  mapMutationOutcome,
  type MutationPresentation,
} from '@/lib/transferPresentation';
import { SubmitGuard } from '@/lib/transferSubmit';

export interface CloseAccountButtonProps {
  /** The owned account number to close. */
  accountNumber: string;
  /**
   * Called once after a successful close (HTTP 201, Requirement 3.6) so the
   * host view can re-fetch and reflect the updated Account_Status.
   */
  onClosed?: () => void;
}

/**
 * POST a close-account request to the BFF and parse the response into the
 * `{ status, error?, message? }` shape `mapMutationOutcome` consumes. A thrown
 * `fetch` is mapped to the BFF's own transport statuses (504 TIMEOUT / 502
 * NETWORK) so a client-side failure routes to the generic retryable error.
 *
 * The fetch target is an inline template literal beginning with '/api/bff/' so
 * the Property 5 static guard can statically confirm the call never reaches the
 * Sandbox_Gateway directly.
 */
async function postCloseAccount(
  accountNumber: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ status: number; error?: string; message?: string }> {
  const doFetch = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`/api/bff/accounts/${encodeURIComponent(accountNumber)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Same-origin credentials carry the HTTP-only session cookie; no token
      // is ever read in the browser.
      credentials: 'same-origin',
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

export function CloseAccountButton({ accountNumber, onClosed }: CloseAccountButtonProps) {
  // Whether the explicit confirmation prompt is revealed. It is NOT revealed by
  // default: the first "Close account" click only reveals it; the request is
  // sent only on an explicit Confirm (Requirement 3.4).
  const [confirming, setConfirming] = useState(false);

  // In-flight guard: the single synchronous source of truth for "a request is
  // in flight", immune to React batching so a double confirm issues one POST.
  const guardRef = useRef<SubmitGuard>(new SubmitGuard());
  const [submitting, setSubmitting] = useState(false);

  // The presentation for the latest completed request, or null before the
  // first outcome. Drives the outcome region.
  const [presentation, setPresentation] = useState<MutationPresentation | null>(null);

  /** Reveal the confirmation prompt. Sends NO request (Requirement 3.4). */
  const handleRequestClose = useCallback(() => {
    setConfirming(true);
    // Clear any prior outcome so the prompt starts clean.
    setPresentation(null);
  }, []);

  /** Cancel the confirmation. Sends NO request; account unchanged (3.7). */
  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  /** Run one close-account request cycle, guarded to one in-flight POST. */
  const runCloseAccount = useCallback(async () => {
    if (!guardRef.current.begin()) return;

    setSubmitting(true);

    try {
      const outcome = await postCloseAccount(accountNumber);
      const next = mapMutationOutcome(outcome);

      // 401 -> route to re-authentication rather than rendering a banner
      // (Requirement 3.10).
      if (next.requiresReauth) {
        void signIn('keycloak', { callbackUrl: window.location.pathname });
        return;
      }

      setPresentation(next);

      // On success, dismiss the prompt and notify the host so it can re-fetch
      // and reflect the updated Account_Status (Requirement 3.6).
      if (next.isSuccess) {
        setConfirming(false);
        onClosed?.();
      }
    } finally {
      guardRef.current.end();
      setSubmitting(false);
    }
  }, [accountNumber, onClosed]);

  const handleConfirm = useCallback(() => {
    void runCloseAccount();
  }, [runCloseAccount]);

  /** Retry seam for the generic-error outcome: re-send the close request. */
  const handleRetry = useCallback(() => {
    void runCloseAccount();
  }, [runCloseAccount]);

  const isError = presentation
    ? presentation.severity === 'error' || presentation.severity === 'warning'
    : false;
  const showRetry = presentation ? presentation.canRetry && !presentation.isRateLimit : false;

  return (
    <div>
      {!confirming ? (
        <button type="button" onClick={handleRequestClose} data-testid="close-account-button">
          Close account
        </button>
      ) : (
        // Accessible confirmation region (no window.confirm). The request is
        // sent only when Confirm is activated (Requirement 3.4); Cancel sends
        // nothing and leaves the account unchanged (Requirement 3.7).
        <div role="group" aria-label="Confirm close account" data-testid="close-account-confirm">
          <p>Are you sure you want to close this account? This cannot be undone.</p>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            data-testid="close-account-confirm-button"
          >
            {submitting ? 'Closing…' : 'Confirm close'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="close-account-cancel-button"
          >
            Cancel
          </button>
        </div>
      )}

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
