/**
 * BFF endpoints for the signed-in customer's profile.
 *
 * `GET /api/bff/customer` proxies the signed-in customer's profile from the
 * sandbox (`GET /customers/me`, Requirement 2.1). `PATCH /api/bff/customer`
 * proxies a profile update (`PATCH /customers/me`, Requirements 7.8, 7.9,
 * 7.13) backed by the Profile_Page's editable fields.
 *
 * Both handlers require a valid session; when unauthenticated they respond 401
 * WITHOUT calling the sandbox. The access token and Sandbox_Key are resolved
 * server-side inside `sandboxClient` and never appear in the response
 * (Requirements 6.7, 9.1, 9.2).
 */

import { getCustomer, updateCustomer } from '@/lib/server/sandboxClient';
import type { CustomerProfileUpdate } from '@/lib/types';
import {
  errorResponse,
  requireSession,
  respondFromMutationResult,
  respondFromResult,
} from '../_lib/respond';

// Reads session/cookies (and PATCH performs an outbound mutation); never
// statically optimized and always runs on the Node.js runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const result = await getCustomer();
  return respondFromResult(result);
}

/**
 * The editable CustomerProfile fields the Profile_Page may submit, i.e. the
 * keys of {@link CustomerProfileUpdate}. Only these keys are ever forwarded to
 * the sandbox; any other key in the body is ignored/stripped so the sandbox
 * only ever sees the editable fields (Requirement 7.9).
 */
const EDITABLE_PROFILE_FIELDS = [
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'postalCode',
  'country',
  'occupation',
  'preferredChannel',
] as const;

/**
 * The outcome of validating/whitelisting an unknown, untrusted request body
 * into a typed {@link CustomerProfileUpdate}. Either a clean, partial object
 * containing only the editable fields that were present, or a safe,
 * machine-readable `error` code describing the first violation found.
 */
type ValidationOutcome =
  | { ok: true; value: CustomerProfileUpdate }
  | { ok: false; error: string };

/**
 * Validate and whitelist an unknown, untrusted request body into a typed
 * {@link CustomerProfileUpdate} (server-side defence-in-depth alongside the
 * client-side validation of Requirement 7.9):
 *   - body is not a JSON object            -> `INVALID_PROFILE`
 *   - any provided editable field is not a string -> `INVALID_PROFILE`
 *
 * Only the editable keys ({@link EDITABLE_PROFILE_FIELDS}) are copied onto the
 * result; unknown keys are ignored/stripped so only editable fields are
 * forwarded to the sandbox. A field is only copied when it is actually present
 * in the body, so the result stays a *partial* update (a missing field is left
 * untouched upstream rather than cleared).
 */
function validateProfileBody(body: unknown): ValidationOutcome {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'INVALID_PROFILE' };
  }

  const b = body as Record<string, unknown>;
  const value: CustomerProfileUpdate = {};

  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (!(field in b)) continue;
    const raw = b[field];
    // Each provided editable field must be a string; reject anything else
    // (number, boolean, object, null) before any outbound call.
    if (typeof raw !== 'string') {
      return { ok: false, error: 'INVALID_PROFILE' };
    }
    value[field] = raw;
  }

  return { ok: true, value };
}

export async function PATCH(req: Request) {
  // 1. Require a valid session BEFORE touching the body or the sandbox.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // 2. Parse the JSON body, tolerating a malformed/empty payload.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_PROFILE');
  }

  // 3. Validate + whitelist server-side (defence-in-depth) before any
  //    outbound call, so the sandbox only ever sees editable string fields.
  const validation = validateProfileBody(rawBody);
  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  // 4. Delegate to the sandbox client and map the outcome. A profile update is
  //    an update, so a successful mutation forwards 200 (not 201).
  const result = await updateCustomer(validation.value);
  return respondFromMutationResult(result, { createdStatus: 200 });
}
