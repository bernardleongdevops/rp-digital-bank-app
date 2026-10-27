/**
 * BFF write endpoint: `POST /api/bff/transfers`.
 *
 * Proxies a money transfer to the sandbox (`POST /payments/transfers`,
 * Requirement 4.1). The browser sends the JSON body
 * `{ fromAccount, toAccount, amount, description }`; this handler requires a
 * valid session, validates the body server-side (defence-in-depth alongside
 * the client-side validation of Requirement 5), delegates to `createTransfer`,
 * and maps the resulting `TransferResult` to the HTTP response the browser
 * receives (Requirements 4.3-4.10).
 *
 * Security posture:
 *   - When unauthenticated it responds 401 WITHOUT calling the sandbox
 *     (`requireSession`), so an unauthenticated browser never triggers an
 *     outbound transfer.
 *   - A malformed/invalid body is rejected with 400 and a safe `error` code
 *     BEFORE the sandbox is called, so the sandbox only ever sees a
 *     well-formed request.
 *   - The access token and the Sandbox_Key are resolved server-side inside
 *     `sandboxClient` and never appear in the response (Requirement 6.7); the
 *     outcome mapper forwards only `status` + `error` (+ a non-secret 409
 *     `message`).
 */

import { createTransfer } from '@/lib/server/sandboxClient';
import type { TransferRequest } from '@/lib/types';
import { errorResponse, requireSession, respondFromTransferResult } from '../_lib/respond';

// Reads session/cookies and performs an outbound mutation; never statically
// optimized and always runs on the Node.js runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Transfer amount bounds (inclusive), matching the client-side rule. */
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 999_999_999.99;

/** Maximum transfer description length (Requirement 5.6). */
const MAX_DESCRIPTION_LENGTH = 140;

/**
 * The outcome of validating/parsing the request body. Either a clean,
 * normalized {@link TransferRequest} ready for the sandbox, or a safe,
 * machine-readable `error` code describing the first violation found.
 */
type ValidationOutcome =
  | { ok: true; value: TransferRequest }
  | { ok: false; error: string };

/**
 * Return true when `amount` is a finite number within the allowed range and
 * carries at most two decimal places. The decimal check is done on the number
 * itself (rounding to cents must not change the value) so inputs like `1.005`
 * are rejected. Non-finite values (NaN/Infinity) are rejected.
 */
function isValidAmount(amount: number): boolean {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) return false;
  // At most two decimal places: rounding to cents must be a no-op (allowing
  // for floating-point representation error).
  const cents = Math.round(amount * 100);
  return Math.abs(cents / 100 - amount) < 1e-9;
}

/**
 * Validate and normalize an unknown, untrusted request body into a typed
 * {@link TransferRequest} (server-side defence-in-depth, Requirement 5). On the
 * first violation it returns a safe `error` code that names the offending field
 * without echoing any user input:
 *   - body is not a JSON object            -> `INVALID_BODY`
 *   - `fromAccount` missing/empty          -> `INVALID_FROM_ACCOUNT`
 *   - `toAccount` missing/empty            -> `INVALID_TO_ACCOUNT`
 *   - `amount` not a number / out of range / >2 decimals -> `INVALID_AMOUNT`
 *   - `description` not a string / too long -> `INVALID_DESCRIPTION`
 *
 * `fromAccount === toAccount` is intentionally NOT rejected here: the sandbox
 * owns that business rule and surfaces it as a 409 `SAME_ACCOUNT` conflict,
 * which the outcome mapper forwards. (The client form also blocks it.)
 */
function validateTransferBody(body: unknown): ValidationOutcome {
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

  return {
    ok: true,
    value: {
      fromAccount: fromAccount.trim(),
      toAccount: toAccount.trim(),
      amount,
      description,
    },
  };
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

  // 3. Validate server-side (defence-in-depth) before any outbound call.
  const validation = validateTransferBody(rawBody);
  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  // 4. Delegate to the sandbox client and map the outcome to the HTTP response.
  const result = await createTransfer(validation.value);
  return respondFromTransferResult(result);
}
