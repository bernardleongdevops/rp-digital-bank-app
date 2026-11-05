/**
 * BFF endpoints for saved payees: `GET /api/bff/payees` and
 * `POST /api/bff/payees`.
 *
 * - `GET` proxies the signed-in customer's saved payees from the sandbox
 *   (`GET /payees` ASSUMED, Requirements 5.4, 5.5). It requires a valid session
 *   and maps the typed `SandboxResult` to the browser response via
 *   `respondFromResult`.
 * - `POST` creates a saved payee (`POST /payees` ASSUMED, Requirements 5.1,
 *   5.2, 5.3). It requires a valid session, re-applies the shared
 *   `validatePayeeForm` rules server-side (defence-in-depth, kept in sync with
 *   the client-side validation for parity, Requirement 5.13) and rejects an
 *   invalid body with 400 `INVALID_PAYEE` BEFORE any outbound call — mirroring
 *   how `transfers/route.ts` returns a safe, machine-readable `error` code —
 *   then delegates to `createPayee` and maps the outcome via
 *   `respondFromMutationResult` (201 on success).
 *
 * Security posture:
 *   - When unauthenticated it responds 401 WITHOUT calling the sandbox
 *     (`requireSession`), so an unauthenticated browser never triggers an
 *     outbound call.
 *   - A malformed/invalid body is rejected with 400 and a safe `error` code
 *     BEFORE the sandbox is called, so the sandbox only ever sees a well-formed
 *     request.
 *   - The access token and the Sandbox_Key are resolved server-side inside
 *     `sandboxClient` and never appear in the response (Requirements 9.1, 9.2);
 *     the respond helpers forward only `status` + `error`/`data`.
 */

import { createPayee, listPayees } from '@/lib/server/sandboxClient';
import { validatePayeeForm } from '@/lib/transferValidation';
import type { CreatePayeeRequest } from '@/lib/types';
import {
  errorResponse,
  requireSession,
  respondFromMutationResult,
  respondFromResult,
} from '../_lib/respond';

// Reads session/cookies and performs outbound calls; never statically
// optimized and always runs on the Node.js runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The outcome of validating/parsing the create-payee body. Either a clean,
 * normalized {@link CreatePayeeRequest} ready for the sandbox, or a safe,
 * machine-readable `error` code describing the violation found.
 */
type ValidationOutcome =
  | { ok: true; value: CreatePayeeRequest }
  | { ok: false; error: string };

/**
 * Validate and normalize an unknown, untrusted request body into a typed
 * {@link CreatePayeeRequest} (server-side defence-in-depth, Requirement 5.2).
 *
 * The pure {@link validatePayeeForm} is the single source of truth for the
 * label / destination-account rules, so the client and server accept and
 * reject the identical inputs (Requirement 5.13, Property 3). Any violation is
 * surfaced as the single safe `error` code `INVALID_PAYEE` without echoing any
 * user input. On success the trimmed values are forwarded.
 */
function validatePayeeBody(body: unknown): ValidationOutcome {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'INVALID_PAYEE' };
  }

  const b = body as Record<string, unknown>;
  const label = typeof b.label === 'string' ? b.label : '';
  const destinationAccount =
    typeof b.destinationAccount === 'string' ? b.destinationAccount : '';

  // Re-apply the shared pure rules server-side for client/server parity.
  const errors = validatePayeeForm({ label, destinationAccount });
  if (Object.keys(errors).length > 0) {
    return { ok: false, error: 'INVALID_PAYEE' };
  }

  return {
    ok: true,
    value: {
      label: label.trim(),
      destinationAccount: destinationAccount.trim(),
    },
  };
}

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const result = await listPayees();
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
    return errorResponse(400, 'INVALID_PAYEE');
  }

  // 3. Validate server-side (defence-in-depth) before any outbound call.
  const validation = validatePayeeBody(rawBody);
  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  // 4. Delegate to the sandbox client and map the mutation outcome (201 OK).
  const result = await createPayee(validation.value);
  return respondFromMutationResult(result, { createdStatus: 201 });
}
