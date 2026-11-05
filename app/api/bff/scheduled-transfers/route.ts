/**
 * BFF endpoints for the signed-in customer's scheduled/recurring transfers:
 *   - `GET  /api/bff/scheduled-transfers` — list scheduled transfers with their
 *     Scheduled_Transfer_Status (Requirements 6.5, 6.7).
 *   - `POST /api/bff/scheduled-transfers` — create a scheduled/recurring
 *     transfer (Requirements 6.1, 6.2, 6.3).
 *
 * Both require a valid session; when unauthenticated they respond 401 WITHOUT
 * calling the sandbox (`requireSession`). Credentials are resolved server-side
 * inside `sandboxClient` and never appear in the response; the respond helpers
 * forward only `status` + `error`/`data` (Requirements 9.1, 9.2).
 *
 * Security posture (mirrors `transfers/route.ts`):
 *   - A malformed/invalid body is rejected with 400 and a safe `error` code
 *     BEFORE any outbound call, so the sandbox only ever sees a well-formed,
 *     future-dated, supported-recurrence request (server-side re-application of
 *     the client-side `validateScheduledTransferForm` rules, Requirement 6.2).
 *   - The access token and the Sandbox_Key are resolved server-side inside
 *     `sandboxClient` and never appear in the response (Requirement 9.2); the
 *     respond helpers forward only `status` + `error` (+ non-secret 409
 *     `message`).
 *
 * Executed-outcome fidelity: the LIST route returns the mapped domain
 * {@link ScheduledTransfer} objects via `respondFromResult`. An executed
 * transfer's outcome travels on `ScheduledTransfer.lastOutcome`
 * (`{ status, error?, message? }`, the Transfer_Form outcome surface) and is
 * re-mapped on the CLIENT through the shared `mapTransferOutcome` so AML
 * held/blocked render identically to the Transfer_Form (Requirement 6.7). We do
 * NOT re-map the executed outcome here.
 */

import { createScheduledTransfer, listScheduledTransfers } from '@/lib/server/sandboxClient';
import type { Recurrence, ScheduledTransferRequest } from '@/lib/types';
import {
  errorResponse,
  requireSession,
  respondFromMutationResult,
  respondFromResult,
} from '../_lib/respond';

// Reads session/cookies and (for POST) performs an outbound mutation; never
// statically optimized and always runs on the Node.js runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Transfer amount bounds (inclusive) and description length, matching the
 * client-side `transferValidation` rule and the `transfers/route.ts`
 * server-side rule so the scheduled money fields are validated identically to
 * the Transfer_Form (Requirement 6.2).
 */
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 999_999_999.99;
const MAX_DESCRIPTION_LENGTH = 140;

/** The supported recurrence set, including the one-off option (Requirement 6.1). */
const RECURRENCE_VALUES: readonly Recurrence[] = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'];

/**
 * The outcome of validating/parsing the create-scheduled-transfer request body.
 * Either a clean, normalized {@link ScheduledTransferRequest} ready for the
 * sandbox, or a safe, machine-readable `error` code describing the first
 * violation found.
 */
type ValidationOutcome =
  | { ok: true; value: ScheduledTransferRequest }
  | { ok: false; error: string };

/**
 * Return true when `amount` is a finite number within the allowed range and
 * carries at most two decimal places. Mirrors `transfers/route.ts`: the decimal
 * check is done on the number itself (rounding to cents must not change the
 * value) so inputs like `1.005` are rejected, and non-finite values
 * (NaN/Infinity) are rejected.
 */
function isValidAmount(amount: number): boolean {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) return false;
  const cents = Math.round(amount * 100);
  return Math.abs(cents / 100 - amount) < 1e-9;
}

/**
 * Validate and normalize an unknown, untrusted request body into a typed
 * {@link ScheduledTransferRequest} (server-side defence-in-depth, Requirement
 * 6.2). This re-applies the same rules as the client-side
 * `validateScheduledTransferForm` — reusing the Transfer_Form money/account
 * rules (amount bounds/decimals, non-empty accounts, source != destination,
 * description <= 140) and layering the schedule-date and recurrence checks on
 * top. Unlike the pure client validator (which operates on raw string form
 * values incl. `amount` as a string), the BFF body uses the
 * {@link ScheduledTransferRequest} wire shape (`amount: number`,
 * `scheduleDate`, `recurrence`), so the numeric/decimal rule is applied to the
 * number directly, exactly as `transfers/route.ts` does.
 *
 * On the first violation it returns a safe `error` code that names the
 * offending field without echoing any user input:
 *   - body is not a JSON object                       -> `INVALID_BODY`
 *   - `fromAccount` missing/empty                      -> `INVALID_FROM_ACCOUNT`
 *   - `toAccount` missing/empty                        -> `INVALID_TO_ACCOUNT`
 *   - `fromAccount === toAccount`                      -> `INVALID_TO_ACCOUNT`
 *   - `amount` not a number / out of range / >2 dp     -> `INVALID_AMOUNT`
 *   - `description` not a string / too long            -> `INVALID_DESCRIPTION`
 *   - `scheduleDate` missing / unparseable / not after now -> `INVALID_SCHEDULE_DATE`
 *   - `recurrence` not one of the supported values     -> `INVALID_RECURRENCE`
 *
 * `now` is passed in (rather than read from the clock inside) so the rule is
 * deterministic and testable; the handler supplies `new Date()`.
 */
function validateScheduledTransferBody(body: unknown, now: Date): ValidationOutcome {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'INVALID_BODY' };
  }

  const b = body as Record<string, unknown>;

  const fromAccount = b.fromAccount;
  if (typeof fromAccount !== 'string' || fromAccount.trim().length === 0) {
    return { ok: false, error: 'INVALID_FROM_ACCOUNT' };
  }

  const toAccount = b.toAccount;
  if (typeof toAccount !== 'string' || toAccount.trim().length === 0) {
    return { ok: false, error: 'INVALID_TO_ACCOUNT' };
  }

  // Source and destination must differ (Requirement 6.2, reusing the
  // Transfer_Form rule). Reported on the destination field.
  if (fromAccount.trim() === toAccount.trim()) {
    return { ok: false, error: 'INVALID_TO_ACCOUNT' };
  }

  const amount = b.amount;
  if (typeof amount !== 'number' || !isValidAmount(amount)) {
    return { ok: false, error: 'INVALID_AMOUNT' };
  }

  // Description is optional (0..140 chars); default a missing value to "".
  let description: string;
  if (b.description === undefined || b.description === null) {
    description = '';
  } else if (typeof b.description === 'string') {
    description = b.description;
  } else {
    return { ok: false, error: 'INVALID_DESCRIPTION' };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: 'INVALID_DESCRIPTION' };
  }

  // Schedule date: present, parseable, and strictly AFTER `now` (Requirement
  // 6.3). Rejected before any outbound call so the sandbox only sees a
  // future-dated request.
  const scheduleDate = b.scheduleDate;
  if (typeof scheduleDate !== 'string' || scheduleDate.trim().length === 0) {
    return { ok: false, error: 'INVALID_SCHEDULE_DATE' };
  }
  const scheduledMs = new Date(scheduleDate.trim()).getTime();
  if (Number.isNaN(scheduledMs) || scheduledMs <= now.getTime()) {
    return { ok: false, error: 'INVALID_SCHEDULE_DATE' };
  }

  // Recurrence must be one of the supported values (Requirement 6.1).
  const recurrence = b.recurrence;
  if (
    typeof recurrence !== 'string' ||
    !RECURRENCE_VALUES.includes(recurrence as Recurrence)
  ) {
    return { ok: false, error: 'INVALID_RECURRENCE' };
  }

  return {
    ok: true,
    value: {
      fromAccount: fromAccount.trim(),
      toAccount: toAccount.trim(),
      amount,
      description,
      scheduleDate: scheduleDate.trim(),
      recurrence: recurrence as Recurrence,
    },
  };
}

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // The list returns the mapped domain objects (incl. each transfer's status
  // and any executed `lastOutcome`); the executed-outcome re-mapping happens on
  // the client via `mapTransferOutcome` (Requirement 6.7) — NOT here.
  const result = await listScheduledTransfers();
  return respondFromResult(result);
}

export async function POST(req: Request) {
  // 1. Require a valid session BEFORE touching the body or the sandbox.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // 2. Parse the JSON body, tolerating a malformed/empty payload.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_BODY');
  }

  // 3. Validate server-side (defence-in-depth) before any outbound call,
  //    re-applying the scheduled-transfer rules incl. strictly-after-now.
  const validation = validateScheduledTransferBody(rawBody, new Date());
  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  // 4. Delegate to the sandbox client and map the outcome; a created scheduled
  //    transfer forwards 201. The 403/409/401/429/timeout/network branches flow
  //    through the shared mutation respond helper.
  const result = await createScheduledTransfer(validation.value);
  return respondFromMutationResult(result, { createdStatus: 201 });
}
