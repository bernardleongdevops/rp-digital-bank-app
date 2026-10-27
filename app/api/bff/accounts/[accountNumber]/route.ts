/**
 * BFF read endpoint: `GET /api/bff/accounts/[accountNumber]`.
 *
 * Proxies one owned account by number from the sandbox
 * (`GET /accounts/{accountNumber}`, Requirement 3.1). The gateway returns 404
 * when the account is not owned; that status/error is forwarded as-is to the
 * browser. Requires a valid session; when unauthenticated it responds 401
 * WITHOUT calling the sandbox. Credentials are resolved server-side inside
 * `sandboxClient` and never appear in the response (Requirement 6.7).
 */

import { getAccount } from '@/lib/server/sandboxClient';
import { errorResponse, requireSession, respondFromResult } from '../../_lib/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: { accountNumber: string };
}

export async function GET(_req: Request, { params }: RouteContext) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const accountNumber = params.accountNumber?.trim();
  if (!accountNumber) {
    // A route match with an empty segment is a malformed request; reject it
    // before touching the sandbox.
    return errorResponse(400, 'INVALID_ACCOUNT_NUMBER');
  }

  const result = await getAccount(accountNumber);
  return respondFromResult(result);
}
