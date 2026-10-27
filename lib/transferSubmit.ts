/**
 * Transfer submission plumbing shared by the Transfer feature (task 9.2).
 *
 * This module is intentionally free of React and of any server-only import so
 * it can be exercised directly by the Property 7 "Idempotent submit guard"
 * test (task 9.4) without mounting a component or standing up a server. It
 * holds two concerns:
 *
 *   1. {@link SubmitGuard} — a tiny, framework-free guard that enforces the
 *      in-flight invariant of Requirement 4.2: WHILE a transfer request is in
 *      progress the submit control is disabled so a double-click or repeated
 *      submit issues at most ONE `POST /api/bff/transfers` per request cycle.
 *      The React container derives its disabled state from the same `submitting`
 *      flag this guard tracks, so the guard is the single source of truth for
 *      "is a request in flight".
 *
 *   2. {@link postTransfer} — the pure "send the request and parse the outcome"
 *      step: it converts the validated form values to a `TransferRequest`
 *      (amount string -> number), POSTs the JSON to the same-origin BFF
 *      endpoint (never the gateway), and parses the response into the
 *      `{ status, error?, message? }` shape {@link mapTransferOutcome} consumes
 *      (Requirements 4.1, 4.3-4.10). Network / unexpected failures are mapped
 *      to the BFF's own transport statuses (502 NETWORK / 502 UNEXPECTED) so a
 *      thrown `fetch` is indistinguishable from the BFF reporting the same.
 *
 * No secrets, no gateway URLs — only the same-origin `/api/bff/transfers` path.
 */

import type { TransferFormValues } from './transferValidation';
import type { TransferOutcomeInput } from './transferPresentation';
import type { TransferRequest } from './types';

/** Same-origin BFF endpoint for a money transfer (never the gateway). */
export const TRANSFER_ENDPOINT = '/api/bff/transfers';

/**
 * A minimal, framework-free in-flight guard enforcing Requirement 4.2.
 *
 * Usage contract:
 *   - `begin()` returns `true` exactly once per request cycle — on the first
 *     call while idle — and marks the guard "in flight". Every subsequent
 *     `begin()` while still in flight returns `false` (the submit is ignored),
 *     which is what prevents a double-click from issuing a second POST.
 *   - `end()` clears the in-flight flag so the NEXT request cycle may begin.
 *   - `isInFlight()` exposes the flag so the UI can disable the submit control
 *     (belt-and-braces alongside the ignored-submit behaviour).
 *
 * The guard owns no React state; the container mirrors `isInFlight()` into a
 * `submitting` state value purely to drive rendering. Because the guard is a
 * plain object, task 9.4 can drive it through arbitrary submit sequences and
 * assert that `begin()` grants permission at most once per cycle.
 */
export class SubmitGuard {
  private inFlight = false;

  /**
   * Attempt to start a request cycle. Returns `true` and latches in-flight when
   * idle; returns `false` (and changes nothing) when a request is already in
   * flight. Callers MUST only issue the outbound POST when this returns `true`.
   */
  begin(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  /** Release the guard at the end of a request cycle (success or failure). */
  end(): void {
    this.inFlight = false;
  }

  /** Whether a request is currently in flight. */
  isInFlight(): boolean {
    return this.inFlight;
  }
}

/**
 * Convert the raw, as-typed form values into the typed {@link TransferRequest}
 * body the BFF expects. The amount is parsed from its validated string form to
 * a number (Requirement 4.1); callers MUST only pass values that have already
 * passed `validateTransferForm`, so `Number(amount)` is finite and in range.
 * The description is forwarded as-is (an empty string is valid, 0..140 chars).
 */
export function toTransferRequest(values: TransferFormValues): TransferRequest {
  return {
    fromAccount: values.fromAccount.trim(),
    toAccount: values.toAccount.trim(),
    amount: Number(values.amount.trim()),
    description: values.description,
  };
}

/**
 * POST a validated transfer to the BFF and parse the response into the
 * `{ status, error?, message? }` shape the outcome mapper consumes.
 *
 * Behaviour:
 *   - Serializes the `TransferRequest` body and sends it to the same-origin
 *     `/api/bff/transfers` (Requirement 4.1); it never targets the gateway.
 *   - Reads the browser-facing `status` from the HTTP response and the
 *     `error`/`message` from the JSON body (the BFF forwards only safe,
 *     non-secret fields). A body that is absent or not JSON is tolerated: the
 *     HTTP `status` alone still drives the outcome.
 *   - A thrown `fetch` (offline / DNS / abort) is mapped to the BFF's own
 *     transport status so the mapper routes it to the generic error state
 *     (Requirement 4.10): `AbortError` -> 504 TIMEOUT, anything else -> 502
 *     NETWORK. This keeps a client-side failure indistinguishable from the BFF
 *     reporting the same transport failure.
 *
 * The optional `fetchImpl` and `signal` seams make this unit-testable and
 * cancellable; production callers pass the global `fetch`.
 */
export async function postTransfer(
  values: TransferFormValues,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TransferOutcomeInput> {
  const doFetch = options.fetchImpl ?? fetch;
  const body = toTransferRequest(values);

  let res: Response;
  try {
    res = await doFetch(TRANSFER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (e) {
    // A thrown fetch means no HTTP exchange completed. Mirror the BFF's
    // transport statuses so the mapper shows the generic, retryable error.
    const isAbort = e instanceof DOMException && e.name === 'AbortError';
    return isAbort
      ? { status: 504, error: 'TIMEOUT' }
      : { status: 502, error: 'NETWORK' };
  }

  // Parse the safe JSON envelope when present; tolerate an empty/non-JSON body.
  let error: string | undefined;
  let message: string | undefined;
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    if (data && typeof data.error === 'string') error = data.error;
    if (data && typeof data.message === 'string') message = data.message;
  } catch {
    // No/!JSON body — fall back to the HTTP status alone.
  }

  return { status: res.status, error, message };
}
