/**
 * BFF endpoints for the signed-in customer's accounts collection:
 *   - `GET  /api/bff/accounts` — list owned accounts (Requirement 2.2).
 *   - `POST /api/bff/accounts` — open a new account (Requirements 3.1, 3.2).
 *
 * Both require a valid session; when unauthenticated they respond 401 WITHOUT
 * calling the sandbox (`requireSession`). Credentials are resolved server-side
 * inside `sandboxClient` and never appear in the response; the respond helpers
 * forward only `status` + `error`/`data` (Requirements 9.1, 9.2).
 */

import { createAccount, listAccounts } from '@/lib/server/sandboxClient';
import type { AccountType, OpenAccountRequest } from '@/lib/types';
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

/** The account types the open-account form accepts (Requirement 3.2). */
const ACCEPTED_ACCOUNT_TYPES: readonly AccountType[] = ['SAVINGS', 'CURRENT'];

/**
 * The outcome of validating/parsing the open-account request body. Either a
 * clean, normalized {@link OpenAccountRequest} ready for the sandbox, or a
 * safe, machine-readable `error` code describing the first violation found.
 */
type ValidationOutcome =
  | { ok: true; value: OpenAccountRequest }
  | { ok: false; error: string };

/**
 * Validate and normalize an unknown, untrusted request body into a typed
 * {@link OpenAccountRequest} (server-side defence-in-depth, Requirement 3.2).
 * On the first violation it returns a safe `error` code that names the
 * offending field without echoing any user input:
 *   - body is not a JSON object               -> `INVALID_BODY`
 *   - `type` missing / not an accepted type   -> `INVALID_ACCOUNT_TYPE`
 *   - `currency` missing/empty / not a string -> `INVALID_CURRENCY`
 *
 * Mirrors the client-side validation of the open-account form so an invalid
 * payload is rejected BEFORE any outbound call to the sandbox is made.
 */
function validateOpenAccountBody(body: unknown): ValidationOutcome {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'INVALID_BODY' };
  }

  const b = body as Record<string, unknown>;

  const type = b.type;
  if (typeof type !== 'string' || !ACCEPTED_ACCOUNT_TYPES.includes(type as AccountType)) {
    return { ok: false, error: 'INVALID_ACCOUNT_TYPE' };
  }

  const currency = b.currency;
  if (typeof currency !== 'string' || currency.trim().length === 0) {
    return { ok: false, error: 'INVALID_CURRENCY' };
  }

  return {
    ok: true,
    value: {
      type: type as AccountType,
      currency: currency.trim(),
    },
  };
}

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const result = await listAccounts();
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

  // 3. Validate server-side (defence-in-depth) before any outbound call.
  const validation = validateOpenAccountBody(rawBody);
  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  // 4. Delegate to the sandbox client and map the outcome; a created account
  //    forwards 201. The 403/409/401/429/timeout/network branches flow through
  //    the shared mutation respond helper.
  const result = await createAccount(validation.value);
  return respondFromMutationResult(result, { createdStatus: 201 });
}
