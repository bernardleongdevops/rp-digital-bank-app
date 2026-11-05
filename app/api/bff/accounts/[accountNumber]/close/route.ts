/**
 * BFF write endpoint: `POST /api/bff/accounts/[accountNumber]/close`.
 *
 * Proxies an account-close request to the sandbox
 * (`POST /accounts/{accountNumber}/close`, Requirements 3.5-3.7). Requires a
 * valid session; when unauthenticated it responds 401 WITHOUT calling the
 * sandbox (`requireSession`). The upstream owns the business rules: a close of
 * an account that cannot be closed (e.g. non-zero balance) surfaces as a 409
 * business conflict, and a not-owner close surfaces as a 403 — both flow
 * through the shared mutation respond helper, which forwards the 409 error code
 * so the client can explain it (Requirements 3.8-3.11).
 *
 * Credentials are resolved server-side inside `sandboxClient` and never appear
 * in the response; only `status` + `error` (+ a non-secret 409 `message`) are
 * forwarded (Requirements 9.1, 9.2).
 */

import { closeAccount } from '@/lib/server/sandboxClient';
import { errorResponse, requireSession, respondFromMutationResult } from '../../../_lib/respond';

// Reads session/cookies and performs an outbound mutation; never statically
// optimized and always runs on the Node.js runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: { accountNumber: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  // 1. Require a valid session BEFORE touching the sandbox.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // 2. A route match with an empty segment is a malformed request; reject it
  //    before any outbound call.
  const accountNumber = params.accountNumber?.trim();
  if (!accountNumber) {
    return errorResponse(400, 'INVALID_ACCOUNT_NUMBER');
  }

  // 3. Delegate to the sandbox client and map the outcome; a closed account
  //    forwards 201. The 403/409 (business conflict, error code forwarded)/
  //    401/429/timeout/network branches flow through the shared helper.
  const result = await closeAccount(accountNumber);
  return respondFromMutationResult(result, { createdStatus: 201 });
}
