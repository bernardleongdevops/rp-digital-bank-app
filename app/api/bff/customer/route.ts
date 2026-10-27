/**
 * BFF read endpoint: `GET /api/bff/customer`.
 *
 * Proxies the signed-in customer's profile from the sandbox
 * (`GET /customers/me`, Requirement 2.1). Requires a valid session; when
 * unauthenticated it responds 401 WITHOUT calling the sandbox. The access
 * token and Sandbox_Key are resolved server-side inside `sandboxClient` and
 * never appear in the response (Requirement 6.7).
 */

import { getCustomer } from '@/lib/server/sandboxClient';
import { requireSession, respondFromResult } from '../_lib/respond';

// Reads session/cookies and must never be statically optimized.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const result = await getCustomer();
  return respondFromResult(result);
}
