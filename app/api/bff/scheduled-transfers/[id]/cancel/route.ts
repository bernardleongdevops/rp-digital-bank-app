/**
 * BFF write endpoint: `POST /api/bff/scheduled-transfers/[id]/cancel`.
 *
 * Cancels a SCHEDULED transfer via the sandbox
 * (`POST /payments/scheduled-transfers/{id}/cancel`, Requirement 6.6). Requires
 * a valid session; when unauthenticated it responds 401 WITHOUT calling the
 * sandbox (`requireSession`).
 *
 * Security posture (mirrors the other mutating routes):
 *   - An empty/missing path id is rejected with 400 and a safe `error` code
 *     BEFORE any outbound call.
 *   - The access token and the Sandbox_Key are resolved server-side inside
 *     `sandboxClient` and never appear in the response (Requirement 9.2); the
 *     respond helper forwards only `status` + `error` (+ non-secret 409
 *     `message`).
 *
 * A cancel attempt on a transfer that has already executed or been cancelled
 * surfaces upstream as a 409 business conflict; `respondFromMutationResult`
 * forwards that 409 with its upstream `error` code (Requirements 6.12, 6.13).
 */

import { cancelScheduledTransfer } from '@/lib/server/sandboxClient';
import { errorResponse, requireSession, respondFromMutationResult } from '../../../_lib/respond';

// Reads session/cookies and performs an outbound mutation; never statically
// optimized and always runs on the Node.js runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: { id: string } }) {
  // 1. Require a valid session BEFORE touching the sandbox.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // 2. Validate the path id server-side before any outbound call.
  const id = ctx.params?.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return errorResponse(400, 'INVALID_SCHEDULED_TRANSFER_ID');
  }

  // 3. Delegate to the sandbox client and map the outcome; an already-executed
  //    or already-cancelled transfer forwards its upstream 409 error code, and
  //    the 403/401/429/timeout/network branches flow through the shared
  //    mutation respond helper.
  const result = await cancelScheduledTransfer(id.trim());
  return respondFromMutationResult(result);
}
