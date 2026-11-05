/**
 * BFF endpoint for deleting a saved payee: `DELETE /api/bff/payees/[payeeId]`.
 *
 * Proxies a saved-payee deletion to the sandbox (`DELETE /payees/{payeeId}`
 * ASSUMED, Requirement 5.7). On success the payee is removed from the
 * Payee_Picker on its next read. Requires a valid session; when unauthenticated
 * it responds 401 WITHOUT calling the sandbox (`requireSession`), so an
 * unauthenticated browser never triggers an outbound call.
 *
 * A route match with an empty `payeeId` segment is a malformed request and is
 * rejected with 400 `INVALID_PAYEE_ID` BEFORE the sandbox is called, mirroring
 * the empty-segment guard on the existing `[accountNumber]` routes.
 *
 * Security posture: the access token and the Sandbox_Key are resolved
 * server-side inside `sandboxClient` and never appear in the response
 * (Requirements 9.1, 9.2). A successful void delete carries no body; it is
 * forwarded as an empty 200 via `respondFromMutationResult`, and every error
 * variant forwards only `status` + `error` through the shared mapping.
 */

import { deletePayee } from '@/lib/server/sandboxClient';
import { errorResponse, requireSession, respondFromMutationResult } from '../../_lib/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: { payeeId: string };
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const payeeId = params.payeeId?.trim();
  if (!payeeId) {
    // A route match with an empty segment is a malformed request; reject it
    // before touching the sandbox.
    return errorResponse(400, 'INVALID_PAYEE_ID');
  }

  // A successful void delete has no body; forward it as an empty 200 so the
  // client has a clear, consumable success status, reusing the shared mutation
  // mapping for every 401 / 403 / 404 / 429 / timeout / network / unexpected
  // branch (forwarding only `status` + `error`).
  const result = await deletePayee(payeeId);
  return respondFromMutationResult(result, { createdStatus: 200 });
}
