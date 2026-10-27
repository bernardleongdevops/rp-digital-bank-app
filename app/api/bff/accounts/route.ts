/**
 * BFF read endpoint: `GET /api/bff/accounts`.
 *
 * Proxies the signed-in customer's owned accounts from the sandbox
 * (`GET /accounts`, Requirement 2.2). Requires a valid session; when
 * unauthenticated it responds 401 WITHOUT calling the sandbox. Credentials are
 * resolved server-side inside `sandboxClient` and never appear in the response
 * (Requirement 6.7).
 */

import { listAccounts } from '@/lib/server/sandboxClient';
import { requireSession, respondFromResult } from '../_lib/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const result = await listAccounts();
  return respondFromResult(result);
}
